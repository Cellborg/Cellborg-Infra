variable "environment" {
  description = "The environment name"
  type        = string
}

variable "mongo_connection_string" {
  description = "MongoDB connection string"
  type        = string
}

variable "jwt_secret" {
  description = "JWT secret key"
  type        = string
}

variable "api_memory" {
  description = "The amount of memory (in MiB) used by the API task"
  type        = number
  default     = 674
}

variable "api_cpu" {
  description = "The number of CPU units used by the API task"
  type        = number
  default     = 896
}

variable "docker_image" {
  description = "ECR docker image for api"
  type        = string
  default     = 536697236385.dkr.ecr.us-east-1.amazonaws.com/cellborg-beta-api:latest
}