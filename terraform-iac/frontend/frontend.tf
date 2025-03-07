provider "aws" {
  region = "us-east-1"  # Change to your desired region
}

terraform {
  backend "s3" {
    bucket         = "cellborg-tf-state"
    key            = "frontend.tfstate"
    region         = "us-east-1"
    encrypt        = true
  }
}

data "aws_ecs_cluster" "cellborg_ecs_cluster" {
  cluster_name = "cellborg-ecs-cluster"
}
data "aws_iam_role" "ecs_execution_role" {
  name = "ecsTaskExecutionRole"
}

data "aws_iam_role" "frontend_task_role" {
  name = "Cellborg-FrontendTaskRole"
}

resource "aws_launch_template" "ecs_spot_launch_template_frontend" {
  name_prefix   = "ecs-spot-launch-template-"
  image_id      = "ami-08162bd4e1350c72c" # Replace with your desired AMI ID
  instance_type = "t2.small"

  key_name = "nat-instance" # Replace with your key pair name

  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [data.aws_security_group.frontend_sec_group.id]
  }

  iam_instance_profile {
    name = aws_iam_instance_profile.ecs_instance_profile_frontend.name
  }

  user_data = base64encode(<<-EOF
              #!/bin/bash
              echo "Starting ECS agent..."
              echo ECS_CLUSTER=${data.aws_ecs_cluster.cellborg_ecs_cluster.id} >> /etc/ecs/ecs.config
              EOF
  )

  tags = {
    Name = "ecs-spot-launch-template"
  }
}

# IAM Instance Profile. This is created in API.
create "aws_iam_instance_profile" "ecs_instance_profile_frontend" {
  name = "ecsInstanceProfile"
  role = data.aws_iam_role.ecs_execution_role.name
}

resource "aws_autoscaling_group" "ecs_spot_asg_frontend" {
  desired_capacity     = 1
  max_size             = 1
  min_size             = 1
  vpc_zone_identifier  = [data.aws_subnet.private.id]

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = 0
      spot_allocation_strategy                 = "capacity-optimized"
    }

    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.ecs_spot_launch_template_frontend.id
        version            = "$Latest"
      }
    }
  }

}


resource "aws_ecs_capacity_provider" "frontend_ecs_spot_capacity_provider" {
  name = "frontend-ecs-spot-capacity-provider"
  

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ecs_spot_asg_frontend.arn
    managed_scaling {
      maximum_scaling_step_size = 2
      minimum_scaling_step_size = 1
      status                    = "ENABLED"
      target_capacity           = 80
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "frontend_ecs_cluster_capacity_providers" {
  cluster_name = "cellborg-ecs-cluster"
  capacity_providers = [aws_ecs_capacity_provider.frontend_ecs_spot_capacity_provider.name]
  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.frontend_ecs_spot_capacity_provider.name
    weight            = 1
  }
}

resource "aws_ecs_task_definition" "frontend_task" {
  family                   = "Cellborg-${var.environment}-Frontend-Task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  memory                   = var.frontend_memory
  cpu                      = var.frontend_cpu
  execution_role_arn       = data.aws_iam_role.ecs_execution_role.arn
  task_role_arn            = data.aws_iam_role.frontend_task_role.arn

  container_definitions = jsonencode([{
    name      = "cellborg-${var.environment}-frontend"
    image     = var.docker_image
    essential = true
    cpu       = var.frontend_cpu
    memory    = var.frontend_memory
    environment = [
      {
        name  = "NODE_ENV"
        value = var.environment
      },
      {
        name  = "NEXTAUTH_SECRET"
        value = var.nextauth_secret
      },
      {
        name  = "NEXTAUTH_URL"
        value = var.frontend_url
      }
    ]
    log_configuration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/ecs/Cellborg-${var.environment}-Frontend-Task"
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "ecs"
      }
    }
    port_mappings = [{
      containerPort = 443
      protocol      = "tcp"
    }]
  }])
}

# Data block for Frontend Security Group
data "aws_security_group" "frontend_sec_group" {
  filter {
    name   = "tag:Name"
    values = ["FrontendSecGroup"]
  }
}

# Data block for Private Subnet
data "aws_subnet" "private" {
  filter {
    name   = "tag:Name"
    values = ["Cellborg-Private-Subnet"]
  }
}

resource "aws_ecs_service" "frontend_service" {
  name            = "Cellborg-${var.environment}-Frontend"
  cluster         = data.aws_ecs_cluster.cellborg_ecs_cluster.id
  task_definition = aws_ecs_task_definition.frontend_task.arn
  desired_count   = 1
  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.frontend_ecs_spot_capacity_provider.name
    weight            = 1
  }
  network_configuration {
    subnets          = [data.aws_subnet.private.id]
    security_groups  = [data.aws_security_group.frontend_sec_group.id]
  }
}