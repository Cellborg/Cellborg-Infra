provider "aws" {
  region = "us-east-1"  # Change to your desired region
}

terraform {
  backend "s3" {
    bucket         = "cellborg-tf-state"
    key            = "lambdas.tfstate"
    region         = "us-east-1"
    encrypt        = true
  }
}


#create dynamodb talbe to store private ips of ecs tasks.

resource "aws_dynamodb_table" "ecs_task_ips" {
  name           = "ecs-task-ips"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "task_type"
  attribute {
    name = "task_type"
    type = "S"
  }
  tags = {
    Name = "ecs-task-ips"
  }
}

# create ecs-privateip-dynamodb lamba function
# This function update the DynamoDB table with the private IPs of the ECS tasks.
resource "aws_iam_role" "lambda_role" {
  name = "lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  managed_policy_arns = [
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess",
    "arn:aws:iam::aws:policy/AmazonECSReadOnlyAccess"
  ]
}

resource "aws_lambda_function" "update_task_ips" {
  filename         = "lambda-ecs-privateip-dynamo.zip" # Path to your Lambda function zip file
  function_name    = "update-task-ips"
  role             = aws_iam_role.lambda_role.arn
  handler          = "index.handler"
  runtime          = "nodejs14.x"
  source_code_hash = filebase64sha256("lambda-ecs-privateip-dynamo.zip")

  environment {
    variables = {
      DYNAMODB_TABLE = aws_dynamodb_table.ecs_task_ips.name
    }
  }
}

resource "aws_cloudwatch_event_rule" "ecs_task_events" {
  name        = "ecs-task-events"
  description = "Trigger Lambda function on ECS task state changes"
  event_pattern = jsonencode({
    source = ["aws.ecs"],
    detail-type = ["ECS Task State Change"]
  })
}

resource "aws_cloudwatch_event_target" "ecs_task_events_target" {
  rule      = aws_cloudwatch_event_rule.ecs_task_events.name
  target_id = "ecs-task-events-target"
  arn       = aws_lambda_function.update_task_ips.arn
}

resource "aws_lambda_permission" "allow_cloudwatch" {
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.update_task_ips.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ecs_task_events.arn
}


# Create SSN document , and lambda to update nginx when dynamodb changes.

resource "aws_ssm_document" "update_nginx" {
  name          = "UpdateNginxConfig"
  document_type = "Command"

  content = <<EOF
  {
    "schemaVersion": "2.2",
    "description": "Update NGINX configuration with ECS task IPs",
    "mainSteps": [
      {
        "action": "aws:runShellScript",
        "name": "updateNginxConfig",
        "inputs": {
          "runCommand": [
            "#!/bin/bash",
            "UI_IP=$(aws dynamodb get-item --table-name ecs-task-ips --key '{\"task_type\": {\"S\": \"cellborg-beta-frontend\"}}' --query 'Item.private_ip.S' --output text || echo \"NOT_FOUND\")",
            "API_IP=$(aws dynamodb get-item --table-name ecs-task-ips --key '{\"task_type\": {\"S\": \"cellborg-beta-api\"}}' --query 'Item.private_ip.S' --output text || echo \"NOT_FOUND\")",
            "if [ \"$UI_IP\" != \"NOT_FOUND\" ]; then",
            "  sed -i \"s|proxy_pass http://.*:80;|proxy_pass http://$UI_IP:80;|g\" /etc/nginx/nginx.conf",
            "fi",
            "if [ \"$API_IP\" != \"NOT_FOUND\" ]; then",
            "  sed -i \"s|proxy_pass http://.*:80;|proxy_pass http://$API_IP:80;|g\" /etc/nginx/nginx.conf",
            "fi",
            "systemctl reload nginx"
          ]
        }
      }
    ]
  }
  EOF
}

resource "aws_lambda_function" "trigger_ssm_command" {
  filename         = "lambda.zip" # Path to your Lambda function zip file
  function_name    = "trigger-ssm-command"
  role             = aws_iam_role.lambda_role.arn
  handler          = "index.handler"
  runtime          = "nodejs14.x"
  source_code_hash = filebase64sha256("lambda.zip")

  environment {
    variables = {
      SSM_DOCUMENT_NAME = aws_ssm_document.update_nginx.name
      INSTANCE_ID       = aws_instance.nat.id
    }
  }
}
