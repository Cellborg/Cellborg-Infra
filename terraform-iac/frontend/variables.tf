variable "environment" {
  description = "The environment name"
  type        = string
}

variable "nextauth_secret" {
  description = "NextAuth secret key"
  type        = string
}

variable "frontend_url" {
  description = "Frontend URL"
  type        = string
}