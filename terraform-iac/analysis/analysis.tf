resource "aws_ecs_task_definition" "analysis_task" {
  family                   = "Cellborg-${var.environment}-Analysis-Task"
  cpu                      = 2048
  memory                   = 8192
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.analysis_task_role.arn

  container_definitions = jsonencode([{
    name      = "cellborg-${var.environment}-analysis_py"
    image     = "${aws_ecr_repository.analysis_py_repo.repository_url}:latest"
    memory    = 2560
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
        awslogs-group         = "/ecs/Cellborg-${var.environment}-Analysis-Task"
        awslogs-region        = "us-west-2"
        awslogs-stream-prefix = "ecs"
      }
    }
  }, {
    name      = "cellborg-${var.environment}-analysis_r"
    image     = "${aws_ecr_repository.analysis_r_repo.repository_url}:latest"
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
        awslogs-group         = "/ecs/Cellborg-${var.environment}-Analysis-Task"
        awslogs-region        = "us-west-2"
        awslogs-stream-prefix = "ecs"
      }
    }
    port_mappings = [{
      containerPort = 8001
      protocol      = "tcp"
    }]
  }])
}

resource "aws_ecs_service" "analysis_service" {
  name            = "Cellborg-${var.environment}-Analysis"
  cluster         = aws_ecs_cluster.analysis_cluster.id
  task_definition = aws_ecs_task_definition.analysis_task.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.compute_subnets[*].id
    security_groups  = [aws_security_group.analysis_sec_group.id]
    assign_public_ip = true
  }
}