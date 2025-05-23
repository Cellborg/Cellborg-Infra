provider "aws" {
  region = "us-east-1"  # Change to your desired region
}

terraform {
  backend "s3" {
    bucket         = "cellborg-tf-state"
    key            = "bedrock.tfstate"
    region         = "us-east-1"
    encrypt        = true
  }
}


resource "aws_vpc" "cellborg_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = {
    Name = "Cellborg"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.cellborg_vpc.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true
  tags = {
    Name = "Cellborg-Public-Subnet"
  }
}

resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.cellborg_vpc.id
  cidr_block        = var.private_subnet_cidr
  availability_zone = var.availability_zone
  tags = {
    Name = "Cellborg-Private-Subnet"
  }
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.cellborg_vpc.id
  tags = {
    Name = "cellborg-igw"
  }
}

# Security Groups
resource "aws_security_group" "nat" {
  vpc_id = aws_vpc.cellborg_vpc.id
  ingress {
    from_port = 80
    to_port = 80
    protocol = "tcp"
    cidr_blocks = [aws_subnet.private.cidr_block]
  }
  ingress {
    from_port = 443
    to_port = 443
    protocol = "tcp"
    cidr_blocks = [aws_subnet.private.cidr_block]
  }
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port = 80
    to_port = 80
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port = 443
    to_port = 443
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = {
    Name = "nat-sg"
  }
}

# NAT Instance
resource "aws_instance" "nat" {
  ami = "ami-0787627ca252e3c43" # Custom ami created manually.
  instance_type = "t2.micro"
  subnet_id = aws_subnet.public.id
  associate_public_ip_address = true
  source_dest_check = false
  key_name = "nat-instance" # this is already existing , created manually.
  vpc_security_group_ids      = [aws_security_group.nat.id]
  tags = {
    Name = "nat-instance"
  }

  user_data = <<-EOF
              #!/bin/bash
              echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf
              sysctl -p
              iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
              yum update -y
              yum install -y nginx aws-cli
              amazon-linux-extras install -y epel
              yum install -y amazon-ssm-agent
              systemctl enable amazon-ssm-agent
              systemctl start amazon-ssm-agent

              # Fetch IPs from DynamoDB
              UI_IP=$(aws dynamodb get-item --table-name ecs-task-ips --key '{"task_type": {"S": "ui-container"}}' --query 'Item.private_ip.S' --output text || echo "NOT_FOUND")
              API_IP=$(aws dynamodb get-item --table-name ecs-task-ips --key '{"task_type": {"S": "api-container"}}' --query 'Item.private_ip.S' --output text || echo "NOT_FOUND")

              # Set default IPs if not found
              if [ "$UI_IP" == "NOT_FOUND" ]; then
                UI_IP="127.0.0.1"
              fi

              if [ "$API_IP" == "NOT_FOUND" ]; then
                API_IP="127.0.0.1"
              fi

              cat <<EOT > /etc/nginx/nginx.conf
              events {}
              http {
                  server {
                      listen 80;
                      server_name beta.cellborg.bio;
                      location / {
                          proxy_pass http://$UI_IP:80;
                          proxy_set_header Host \$host;
                          proxy_set_header X-Real-IP \$remote_addr;
                          proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
                          proxy_set_header X-Forwarded-Proto \$scheme;
                      }
                  }
                  server {
                      listen 80;
                      server_name api.beta.cellborg.bio;
                      location / {
                          proxy_pass http://$API_IP:80;
                          proxy_set_header Host \$host;
                          proxy_set_header X-Real-IP \$remote_addr;
                          proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
                          proxy_set_header X-Forwarded-Proto \$scheme;
                      }
                  }
              }
              EOT

              systemctl enable nginx
              systemctl start nginx

              # Script to update NGINX configuration with ECS task IPs
              cat <<'EOT' > /usr/local/bin/update_nginx.sh
              #!/bin/bash
              UI_IP=$(aws dynamodb get-item --table-name ecs-task-ips --key '{"task_type": {"S": "ui-container"}}' --query 'Item.private_ip.S' --output text || echo "NOT_FOUND")
              API_IP=$(aws dynamodb get-item --table-name ecs-task-ips --key '{"task_type": {"S": "api-container"}}' --query 'Item.private_ip.S' --output text || echo "NOT_FOUND")

              if [ "$UI_IP" != "NOT_FOUND" ]; then
                sed -i "s|proxy_pass http://.*:80;|proxy_pass http://$UI_IP:80;|g" /etc/nginx/nginx.conf
              fi

              if [ "$API_IP" != "NOT_FOUND" ]; then
                sed -i "s|proxy_pass http://.*:80;|proxy_pass http://$API_IP:80;|g" /etc/nginx/nginx.conf
              fi

              systemctl reload nginx
              EOT

              chmod +x /usr/local/bin/update_nginx.sh
              echo "*/5 * * * * root /usr/local/bin/update_nginx.sh" >> /etc/crontab
              EOT
              systemctl enable nginx
              systemctl start nginx
              EOF

  lifecycle {
    create_before_destroy = true
  }
  instance_market_options {
    market_type = "spot"
    spot_options {
      instance_interruption_behavior = "stop"
      spot_instance_type             = "persistent"
      max_price                      = 0.003
    }
  }

  depends_on = [aws_security_group.nat]
}

# Elastic IP for NAT Instance
resource "aws_eip" "nat" {
  instance = aws_instance.nat.id
  vpc = true
}

# Data block to get the network interface ID of the NAT instance
data "aws_network_interfaces" "nat" {
  filter {
    name   = "attachment.instance-id"
    values = [aws_instance.nat.id]
  }
}
# Route Tables
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.cellborg_vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = {
    Name = "public-rt"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.cellborg_vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    network_interface_id = data.aws_network_interfaces.nat.ids[0]
  }
  route {
    cidr_block = aws_vpc.cellborg_vpc.cidr_block
    gateway_id = "local"
  }
  tags = {
    Name = "private-rt"
  }
}

# Route Table Associations
resource "aws_route_table_association" "public" {
  subnet_id = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  subnet_id = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}



resource "aws_security_group" "private" {
  vpc_id = aws_vpc.cellborg_vpc.id
  ingress {
    from_port = 0
    to_port = 65535
    protocol = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }
  egress {
    from_port = 0
    to_port = 65535
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = {
    Name = "private-sg"
  }
}

# create an ECS cluster
resource "aws_ecs_cluster" "cellborg_ecs_cluster" {
  name = "cellborg-ecs-cluster"
}

# create role
# ECS Execution Role
resource "aws_iam_role" "ecs_execution_role" {
  name = "ecsTaskExecutionRole"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    "Statement": [
        {
            "Action": "sts:AssumeRole",
            "Principal": {
                "Service": [
                    "ecs-tasks.amazonaws.com",
                    "ecs.amazonaws.com",
                    "ec2.amazonaws.com"
                ]
            },
            "Effect": "Allow"
        }
    ]
  })

  managed_policy_arns = [
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  ]
}

# API Task Role
resource "aws_iam_role" "api_task_role" {
  name = "Cellborg-ApiTaskRole"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    "Statement": [
        {
            "Action": "sts:AssumeRole",
            "Principal": {
                "Service": [
                    "ecs-tasks.amazonaws.com",
                    "ecs.amazonaws.com",
                    "ec2.amazonaws.com"
                ]
            },
            "Effect": "Allow"
        }
    ]
  })

  managed_policy_arns = [
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
  ]
}

# Frontend Task Role
resource "aws_iam_role" "frontend_task_role" {
  name = "Cellborg-FrontendTaskRole"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    "Statement": [
        {
            "Action": "sts:AssumeRole",
            "Principal": {
                "Service": [
                    "ecs-tasks.amazonaws.com",
                    "ecs.amazonaws.com",
                    "ec2.amazonaws.com"
                ]
            },
            "Effect": "Allow"
        }
    ]
  })

  managed_policy_arns = [
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
  ]
}


# create security Groups

# Security Group for API
resource "aws_security_group" "api_sec_group" {
  vpc_id = aws_vpc.cellborg_vpc.id
  description = "Security group for API"
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = {
    Name = "ApiSecGroup"
  }
}

# Security Group for Frontend
resource "aws_security_group" "frontend_sec_group" {
  vpc_id = aws_vpc.cellborg_vpc.id
  description = "Security group for Frontend"
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = {
    Name = "FrontendSecGroup"
  }
}

# Ingress Rule: Allow frontend to access API on port 443
resource "aws_security_group_rule" "frontend_to_api" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = aws_security_group.api_sec_group.id
  source_security_group_id = aws_security_group.frontend_sec_group.id
  description              = "Allow frontend to access API on port 443"
}

# Ingress Rule: Allow external HTTPS traffic to API
resource "aws_security_group_rule" "external_to_api" {
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  security_group_id = aws_security_group.api_sec_group.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow external HTTPS traffic to API"
}

# Ingress Rule: Allow NAT instance to access API on port 80
resource "aws_security_group_rule" "nat_to_api_80" {
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  security_group_id        = aws_security_group.api_sec_group.id
  source_security_group_id = aws_security_group.nat.id
  description              = "Allow NAT instance to access API on port 80"
}

# Ingress Rule: Allow NAT instance to access API on port 443
resource "aws_security_group_rule" "nat_to_api_443" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = aws_security_group.api_sec_group.id
  source_security_group_id = aws_security_group.nat.id
  description              = "Allow NAT instance to access API on port 443"
}

#====frontend rules=====

# Ingress Rule: Allow external traffic to Frontend on port 3000
resource "aws_security_group_rule" "external_to_frontend" {
  type              = "ingress"
  from_port         = 3000
  to_port           = 3000
  protocol          = "tcp"
  security_group_id = aws_security_group.frontend_sec_group.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow external traffic to Frontend on port 3000"
}

# Ingress Rule: Allow NAT instance to access Frontend on port 80
resource "aws_security_group_rule" "nat_to_frontend_80" {
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  security_group_id        = aws_security_group.frontend_sec_group.id
  source_security_group_id = aws_security_group.nat.id
  description              = "Allow NAT instance to access Frontend on port 80"
}

# Ingress Rule: Allow NAT instance to access Frontend on port 443
resource "aws_security_group_rule" "nat_to_frontend_443" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = aws_security_group.frontend_sec_group.id
  source_security_group_id = aws_security_group.nat.id
  description              = "Allow NAT instance to access Frontend on port 443"
}
