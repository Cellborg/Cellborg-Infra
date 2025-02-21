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
resource "aws_ecs_task_definition" "api_task" {
  family                   = "Cellborg-${var.environment}-Api-Task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  memory                   = var.api_memory
  cpu                      = var.api_cpu
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.api_task_role.arn

  container_definitions = jsonencode([{
    name      = "cellborg-${var.environment}-api"
    image     = var.docker_image
    essential = true
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

resource "aws_ecs_service" "api_service" {
  name            = "Cellborg-${var.environment}-Api"
  cluster         = data.aws_ecs_cluster.cellborg_ecs_cluster.id
  task_definition = aws_ecs_task_definition.api_task.arn
  desired_count   = 1
  launch_type     = "EC2"
  network_configuration {
    subnets          = aws_subnet.compute_subnets[*].id
    security_groups  = [aws_security_group.api_sec_group.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api_target_group.arn
    container_name   = "cellborg-${var.environment}-api"
    container_port   = 443
  }
  depends_on = [aws_lb_listener.api_listener]
}