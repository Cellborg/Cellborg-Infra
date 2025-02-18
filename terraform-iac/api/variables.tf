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