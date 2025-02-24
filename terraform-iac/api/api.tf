provider "aws" {
  region = "us-east-1"  # Change to your desired region
}

terraform {
  backend "s3" {
    bucket         = "cellborg-tf-state"
    key            = "api.tfstate"
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

data "aws_iam_role" "api_task_role" {
  name = "Cellborg-ApiTaskRole"
}

resource "aws_launch_template" "ecs_spot_launch_template" {
  name_prefix   = "ecs-spot-launch-template-"
  image_id      = "ami-02651dfcdf3103c67" # Replace with your desired AMI ID
  instance_type = "t2.small"

  key_name = "nat-instance" # Replace with your key pair name

  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [data.aws_security_group.api_sec_group.id]
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

resource "aws_autoscaling_group" "ecs_spot_asg" {
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
        launch_template_id = aws_launch_template.ecs_spot_launch_template.id
        version            = "$Latest"
      }
    }
  }

}


resource "aws_ecs_capacity_provider" "api_ecs_spot_capacity_provider" {
  name = "api-ecs-spot-capacity-provider"
  

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ecs_spot_asg.arn
    managed_scaling {
      maximum_scaling_step_size = 2
      minimum_scaling_step_size = 1
      status                    = "ENABLED"
      target_capacity           = 100
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "ecs_cluster_capacity_providers" {
  cluster_name = "cellborg-ecs-cluster"
  capacity_providers = [aws_ecs_capacity_provider.api_ecs_spot_capacity_provider.name]
  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.api_ecs_spot_capacity_provider.name
    weight            = 1
  }
}

resource "aws_ecs_task_definition" "api_task" {
  family                   = "Cellborg-${var.environment}-Api-Task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  memory                   = var.api_memory
  cpu                      = var.api_cpu
  execution_role_arn       = data.aws_iam_role.ecs_execution_role.arn
  task_role_arn            = data.aws_iam_role.api_task_role.arn

  container_definitions = jsonencode([{
    name      = "cellborg-${var.environment}-api"
    image     = var.docker_image
    essential = true
    cpu       = var.api_cpu
    memory    = var.api_memory
    environment = [
      {
        name  = "NODE_ENV"
        value = var.environment
      },
      {
        name  = "MONGO_CONNECTION_STRING"
        value = var.mongo_connection_string
      },
      {
        name  = "JWT_SECRET"
        value = var.jwt_secret
      }
    ]
    log_configuration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/ecs/Cellborg-${var.environment}-Api-Task"
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

# Data block for API Security Group
data "aws_security_group" "api_sec_group" {
  filter {
    name   = "tag:Name"
    values = ["ApiSecGroup"]
  }
}

# Data block for Private Subnet
data "aws_subnet" "private" {
  filter {
    name   = "tag:Name"
    values = ["Cellborg-Private-Subnet"]
  }
}

resource "aws_ecs_service" "api_service" {
  name            = "Cellborg-${var.environment}-Api"
  cluster         = data.aws_ecs_cluster.cellborg_ecs_cluster.id
  task_definition = aws_ecs_task_definition.api_task.arn
  desired_count   = 1
  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.api_ecs_spot_capacity_provider.name
    weight            = 1
  }
  network_configuration {
    subnets          = [data.aws_subnet.private.id]
    security_groups  = [data.aws_security_group.api_sec_group.id]
  }
}