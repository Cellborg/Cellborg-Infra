variable "environment" {
  description = "The environment name"
  type        = string
}

variable "frontend_memory" {
  description = "The amount of memory (in MiB) used by the frontend task"
  type        = number
  default     = 1024
}

variable "frontend_cpu" {
  description = "The number of CPU units used by the frontend task"
  type        = number
  default     = 512
}

variable "docker_image" {
  description = "ECR docker image for frontend"
  type        = string
  default     = "536697236385.dkr.ecr.us-east-1.amazonaws.com/cellborg-beta-frontend:latest"
}

variable "nextauth_secret" {
  description = "NextAuth secret key"
  type        = string
}

variable "frontend_url" {
  description = "Frontend URL"
  type        = string
}