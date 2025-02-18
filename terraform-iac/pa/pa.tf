provider "aws" {
  region = "us-east-1"  # Change to your desired region
}

terraform {
  backend "s3" {
    bucket         = "cellborg-tf-state"
    key            = "pa.tfstate"
    region         = "us-east-1"
    encrypt        = true
  }
}

resource "aws_ecs_task_definition" "pa_task" {
  family                   = "Cellborg-${var.environment}-PA-Task"
  cpu                      = 4096
  memory                   = 12288
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.pa_task_role.arn

  container_definitions = jsonencode([{
    name      = "cellborg-${var.environment}-pa_pyrunner"
    image     = "${aws_ecr_repository.pa_py_runner_repo.repository_url}:latest"
    memory    = 8192
    cpu       = 2048
    essential = true
    environment = [
      {
        name  = "ENVIRONMENT"
        value = var.environment
      },
      {
        name  = "AWS_ACCESS_KEY_ID"
        value = var.aws_access_key_id
      },
      {
        name  = "AWS_SECRET_ACCESS_KEY"
        value = var.aws_secret_access_key
      }
    ]
    log_configuration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/ecs/Cellborg-${var.environment}-PA-Task"
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "ecs"
      }
    }
    port_mappings = [{
      containerPort = 8001
      protocol      = "tcp"
    }]
    health_check = {
      command     = ["CMD-SHELL", "curl -f http://localhost:8001/health || exit 1"]
      interval    = 30
      retries     = 5
      startPeriod = 5
      timeout     = 2
    }
  }, {
    name      = "cellborg-${var.environment}-pa_py"
    image     = "${aws_ecr_repository.pa_py_repo.repository_url}:latest"
    memory    = 4096
    cpu       = 1024
    essential = true
    environment = [
      {
        name  = "ENVIRONMENT"
        value = var.environment
      }
    ]
    log_configuration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/ecs/Cellborg-${var.environment}-PA-Task"
        awslogs-region        = "us-east-1"
        awslogs-stream-prefix = "ecs"
      }
    }
  }])
}

resource "aws_ecs_service" "pa_service" {
  name            = "Cellborg-${var.environment}-PA"
  cluster         = aws_ecs_cluster.pa_cluster.id
  task_definition = aws_ecs_task_definition.pa_task.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.compute_subnets[*].id
    security_groups  = [aws_security_group.pa_sec_group.id]
    assign_public_ip = true
  }
}