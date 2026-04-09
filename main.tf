provider "aws" {
  region = "us-east-2"
}

# Matches SoundcloudRole in template.yaml
resource "aws_iam_role" "lambda_role" {
  name = "SoundcloudRole"

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
}

# Matches the 'root' inline policy in template.yaml
resource "aws_iam_role_policy" "lambda_root_policy" {
  name = "root"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "*"
        Resource = "*"
      }
    ]
  })
}

# Matches PlaylistBackupFn
resource "aws_lambda_function" "playlist_backup" {
  filename      = "playlist-backup.zip"
  function_name = "PlaylistBackupFn"
  role          = aws_iam_role.lambda_role.arn
  handler       = "app.lambdaHandler"
  runtime       = "nodejs22.x"
  timeout       = 900 # Matches Globals.Function.Timeout

  source_code_hash = filebase64sha256("playlist-backup.zip")
}

# Matches ScheduledEvent (Type: Schedule)
resource "aws_cloudwatch_event_rule" "every_day" {
  name                = "soundcloud-backup-schedule"
  description         = "Fires every day"
  schedule_expression = "cron(0 0 * * ? *)"
}

resource "aws_cloudwatch_event_target" "check_every_day" {
  rule      = aws_cloudwatch_event_rule.every_day.name
  target_id = "lambda"
  arn       = aws_lambda_function.playlist_backup.arn
}

resource "aws_lambda_permission" "allow_cloudwatch" {
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.playlist_backup.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.every_day.arn
}