data "aws_partition" "current" {}

locals {
  bucket_name             = "${var.name_prefix}-ops-metrics"
  collector_function_name = "${var.name_prefix}-ops-metrics-collector"
  reader_function_name    = "${var.name_prefix}-ops-metrics-reader"

  bucket_objects_arn = "${aws_s3_bucket.ops_metrics.arn}/*"

  # S3 answers 403 instead of 404 for a missing key when the caller cannot list
  # the bucket. The collector must see 404 to start a new day file, and the
  # page must see 404 through a presigned URL to show a gap.
  bucket_list_statement = {
    Effect   = "Allow"
    Action   = ["s3:ListBucket"]
    Resource = aws_s3_bucket.ops_metrics.arn
  }

  collector_iam_statements = concat(
    [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:${data.aws_partition.current.partition}:logs:*:${var.account_id}:log-group:/aws/lambda/${local.collector_function_name}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:StartQuery"]
        Resource = "arn:${data.aws_partition.current.partition}:logs:*:${var.account_id}:log-group:${var.service_log_group_name}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:GetQueryResults"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricData"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = local.bucket_objects_arn
      },
      local.bucket_list_statement,
    ],
    var.bucket_kms_arn != null ? [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
      Resource = var.bucket_kms_arn
    }] : [],
  )

  reader_iam_statements = concat(
    [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:${data.aws_partition.current.partition}:logs:*:${var.account_id}:log-group:/aws/lambda/${local.reader_function_name}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:${data.aws_partition.current.partition}:ssm:*:${var.account_id}:parameter${var.token_ssm_name}"
      },
      # A presigned URL has the permissions of the role that signs it.
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = local.bucket_objects_arn
      },
      local.bucket_list_statement,
    ],
    var.token_kms_arn != "" ? [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = var.token_kms_arn
    }] : [],
    var.bucket_kms_arn != null ? [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = var.bucket_kms_arn
    }] : [],
  )

  lambda_assume_role_policy = jsonencode({
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
}

resource "aws_s3_bucket" "ops_metrics" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_public_access_block" "ops_metrics" {
  bucket = aws_s3_bucket.ops_metrics.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ops_metrics" {
  bucket = aws_s3_bucket.ops_metrics.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.bucket_kms_arn != null ? "aws:kms" : "AES256"
      kms_master_key_id = var.bucket_kms_arn
    }
    bucket_key_enabled = var.bucket_kms_arn != null
  }
}

# The page gets the files from S3 with presigned URLs.
resource "aws_s3_bucket_cors_configuration" "ops_metrics" {
  bucket = aws_s3_bucket.ops_metrics.id

  cors_rule {
    allowed_methods = ["GET"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["*"]
    max_age_seconds = 300
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "ops_metrics" {
  bucket = aws_s3_bucket.ops_metrics.id

  rule {
    id     = "expire-5min"
    status = "Enabled"

    filter {
      prefix = "5min/"
    }

    expiration {
      days = var.raw_retention_days
    }
  }
}

# Both functions run from the same zip, with different handlers. The zip is
# written outside the source dir to avoid packaging its own output.
data "archive_file" "ops_metrics" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/ops_metrics.zip"
  excludes = [
    "collector.test.mjs",
    "insights.test.mjs",
    "metrics.test.mjs",
    "queries.test.mjs",
    "reader.test.mjs",
    "store.test.mjs",
    "mock-aws-loader.mjs",
    "stub-cloudwatch.mjs",
    "stub-cloudwatch-logs.mjs",
    "stub-s3.mjs",
    "stub-s3-request-presigner.mjs",
    "stub-ssm.mjs",
    "ops_metrics.zip"
  ]
}

resource "aws_iam_role" "collector" {
  name               = local.collector_function_name
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy" "collector" {
  name_prefix = "${local.collector_function_name}-"
  role        = aws_iam_role.collector.name

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.collector_iam_statements
  })
}

#tfsec:ignore:aws-lambda-enable-tracing
resource "aws_lambda_function" "collector" {
  function_name                  = local.collector_function_name
  description                    = "Writes eVaka operational metrics to S3 in 5-minute buckets"
  role                           = aws_iam_role.collector.arn
  handler                        = "collector.handler"
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  memory_size                    = 256
  timeout                        = 300 # Must exceed MIN_REMAINING_MS in lambda/collector.mjs.
  reserved_concurrent_executions = 1   # Two runs must not write the same day file at the same time.
  filename                       = data.archive_file.ops_metrics.output_path
  source_code_hash               = data.archive_file.ops_metrics.output_base64sha256

  environment {
    variables = {
      BUCKET                  = aws_s3_bucket.ops_metrics.bucket
      SERVICE_LOG_GROUP_NAME  = var.service_log_group_name
      RDS_INSTANCE_IDENTIFIER = var.rds_instance_identifier
      INGESTION_DELAY_SECONDS = var.ingestion_delay_seconds
    }
  }
}

resource "aws_cloudwatch_event_rule" "collector" {
  name                = local.collector_function_name
  description         = "Collect eVaka operational metrics every 5 minutes"
  schedule_expression = var.collector_schedule
}

resource "aws_cloudwatch_event_target" "collector" {
  rule = aws_cloudwatch_event_rule.collector.name
  arn  = aws_lambda_function.collector.arn
}

resource "aws_lambda_permission" "collector_eventbridge_invoke" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.collector.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.collector.arn
}

resource "aws_iam_role" "reader" {
  name               = local.reader_function_name
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy" "reader" {
  name_prefix = "${local.reader_function_name}-"
  role        = aws_iam_role.reader.name

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.reader_iam_statements
  })
}

#tfsec:ignore:aws-lambda-enable-tracing
resource "aws_lambda_function" "reader" {
  function_name    = local.reader_function_name
  description      = "Checks the bearer token and returns presigned URLs to the ops-metrics files"
  role             = aws_iam_role.reader.arn
  handler          = "reader.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 10
  filename         = data.archive_file.ops_metrics.output_path
  source_code_hash = data.archive_file.ops_metrics.output_base64sha256

  environment {
    variables = {
      BUCKET         = aws_s3_bucket.ops_metrics.bucket
      TOKEN_SSM_NAME = var.token_ssm_name
    }
  }
}

# The function checks the bearer token itself. A public Function URL needs both
# permissions below; the console adds them, the API does not.
resource "aws_lambda_function_url" "reader" {
  function_name      = aws_lambda_function.reader.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = var.allowed_origins
    allow_methods = ["GET"]
    allow_headers = ["authorization"]
    max_age       = 300
  }
}

resource "aws_lambda_permission" "reader_function_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.reader.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "reader_function_url_invoke" {
  statement_id             = "AllowPublicFunctionUrlInvoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.reader.function_name
  principal                = "*"
  invoked_via_function_url = true
}
