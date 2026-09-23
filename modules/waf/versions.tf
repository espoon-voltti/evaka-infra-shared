terraform {
  required_version = ">= 1.3"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # 5.60 is the floor for rate_based_statement.evaluation_window_sec.
      version = ">= 5.60"
    }
  }
}
