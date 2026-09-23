locals {
  acl_name          = "${var.name_prefix}-waf"
  whitelist_enabled = length(var.rate_limit_whitelist_ips) > 0

  # The alarms need the region, and this module spans AWS provider 5.x and 6.x,
  # whose aws_region data source disagrees on the attribute that holds it
  # (`name` vs `region`). The ACL's own ARN carries it in either.
  region = split(":", aws_wafv2_web_acl.this.arn)[3]

  # AWS managed rule groups, with the per-rule downgrades eVaka has needed.
  # The downgrades are kept while enforce is false even though WAF ignores them
  # under a group-level count override, so flipping enforce changes nothing else.
  managed_rule_groups = {
    common-set = {
      name     = "AWSManagedRulesCommonRuleSet"
      priority = 500
      count_rules = [
        "SizeRestrictions_QUERYSTRING",
        "SizeRestrictions_Cookie_HEADER",
        "SizeRestrictions_BODY",
        "SizeRestrictions_URIPATH",
        # These three strike attachment uploads.
        "CrossSiteScripting_BODY",
        "GenericLFI_BODY",
        "GenericRFI_BODY",
      ]
      captcha_rules = []
    }
    ip-reputation = {
      name        = "AWSManagedRulesAmazonIpReputationList"
      priority    = 600
      count_rules = []
      captcha_rules = [
        "AWSManagedIPReputationList",
        "AWSManagedReconnaissanceList",
        "AWSManagedIPDDoSList",
      ]
    }
    bad-input = {
      name          = "AWSManagedRulesKnownBadInputsRuleSet"
      priority      = 700
      count_rules   = []
      captcha_rules = []
    }
    sqli = {
      name     = "AWSManagedRulesSQLiRuleSet"
      priority = 810
      # Strikes attachment uploads.
      count_rules   = ["SQLi_BODY"]
      captcha_rules = []
    }
    posix = {
      name          = "AWSManagedRulesUnixRuleSet"
      priority      = 820
      count_rules   = []
      captcha_rules = []
    }
    linux = {
      name          = "AWSManagedRulesLinuxRuleSet"
      priority      = 830
      count_rules   = []
      captcha_rules = []
    }
  }
}

# Web ACL
#
# Rule names and priorities match eVaka's own ACL exactly, so an eVaka
# environment can be pointed at this module later without renaming a rule or
# losing the metric history that hangs off the rule names.

resource "aws_wafv2_web_acl" "this" {
  name        = local.acl_name
  description = "WAF for ${var.name_prefix}"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.acl_name
    sampled_requests_enabled   = var.enable_sampled_requests
  }

  # Requests carrying the shared credential skip every rule below.
  dynamic "rule" {
    # for_each rejects a value derived from a sensitive one; only whether a
    # credential is configured is unwrapped here, never the credential.
    for_each = nonsensitive(var.basic_auth_exception == null ? [] : [1])

    content {
      name     = "${var.name_prefix}-basic-auth-exception"
      priority = 50

      action {
        allow {}
      }

      statement {
        byte_match_statement {
          positional_constraint = "EXACTLY"
          search_string         = "Basic ${var.basic_auth_exception}"

          field_to_match {
            single_header {
              name = "authorization"
            }
          }

          # The header is matched as sent, so no transformation may normalize
          # the base64 payload.
          text_transformation {
            priority = 0
            type     = "NONE"
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name_prefix}-basic-auth-exception"
        sampled_requests_enabled   = var.enable_sampled_requests
      }
    }
  }

  # Finnish and non-Finnish traffic are rate limited by separate rules at the
  # same limit, giving each its own metric.
  rule {
    name     = "${var.name_prefix}-rate-limit-fi"
    priority = 200

    dynamic "action" {
      for_each = var.enforce ? [1] : []
      content {
        captcha {}
      }
    }
    dynamic "action" {
      for_each = var.enforce ? [] : [1]
      content {
        count {}
      }
    }

    statement {
      rate_based_statement {
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
        limit                 = var.rate_limit

        # An and_statement takes a fixed number of clauses, so the whitelisted
        # and non-whitelisted shapes are separate blocks rather than one with a
        # conditional clause.
        dynamic "scope_down_statement" {
          for_each = local.whitelist_enabled ? [1] : []
          content {
            and_statement {
              statement {
                geo_match_statement {
                  country_codes = ["FI"]
                }
              }
              statement {
                not_statement {
                  statement {
                    ip_set_reference_statement {
                      arn = aws_wafv2_ip_set.rate_limit_whitelist[0].arn
                    }
                  }
                }
              }
            }
          }
        }
        dynamic "scope_down_statement" {
          for_each = local.whitelist_enabled ? [] : [1]
          content {
            geo_match_statement {
              country_codes = ["FI"]
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit-fi"
      sampled_requests_enabled   = var.enable_sampled_requests
    }
  }

  rule {
    name     = "${var.name_prefix}-rate-limit-notfi"
    priority = 201

    dynamic "action" {
      for_each = var.enforce ? [1] : []
      content {
        captcha {}
      }
    }
    dynamic "action" {
      for_each = var.enforce ? [] : [1]
      content {
        count {}
      }
    }

    statement {
      rate_based_statement {
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
        limit                 = var.rate_limit

        dynamic "scope_down_statement" {
          for_each = local.whitelist_enabled ? [1] : []
          content {
            and_statement {
              statement {
                not_statement {
                  statement {
                    geo_match_statement {
                      country_codes = ["FI"]
                    }
                  }
                }
              }
              statement {
                not_statement {
                  statement {
                    ip_set_reference_statement {
                      arn = aws_wafv2_ip_set.rate_limit_whitelist[0].arn
                    }
                  }
                }
              }
            }
          }
        }
        dynamic "scope_down_statement" {
          for_each = local.whitelist_enabled ? [] : [1]
          content {
            not_statement {
              statement {
                geo_match_statement {
                  country_codes = ["FI"]
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit-notfi"
      sampled_requests_enabled   = var.enable_sampled_requests
    }
  }

  dynamic "rule" {
    for_each = local.whitelist_enabled ? [1] : []

    content {
      name     = "${var.name_prefix}-rate-limit-whitelist"
      priority = 300

      dynamic "action" {
        for_each = var.enforce ? [1] : []
        content {
          captcha {}
        }
      }
      dynamic "action" {
        for_each = var.enforce ? [] : [1]
        content {
          count {}
        }
      }

      statement {
        rate_based_statement {
          aggregate_key_type    = "IP"
          evaluation_window_sec = 300
          limit                 = var.rate_limit_whitelist

          scope_down_statement {
            ip_set_reference_statement {
              arn = aws_wafv2_ip_set.rate_limit_whitelist[0].arn
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name_prefix}-rate-limit-whitelist"
        sampled_requests_enabled   = var.enable_sampled_requests
      }
    }
  }

  dynamic "rule" {
    for_each = var.allowed_countries == null ? [] : [1]

    content {
      name     = "${var.name_prefix}-geo"
      priority = 400

      dynamic "action" {
        for_each = var.enforce ? [1] : []
        content {
          block {}
        }
      }
      dynamic "action" {
        for_each = var.enforce ? [] : [1]
        content {
          count {}
        }
      }

      dynamic "statement" {
        for_each = local.whitelist_enabled ? [1] : []
        content {
          and_statement {
            statement {
              not_statement {
                statement {
                  geo_match_statement {
                    country_codes = var.allowed_countries
                  }
                }
              }
            }
            statement {
              not_statement {
                statement {
                  ip_set_reference_statement {
                    arn = aws_wafv2_ip_set.rate_limit_whitelist[0].arn
                  }
                }
              }
            }
          }
        }
      }
      dynamic "statement" {
        for_each = local.whitelist_enabled ? [] : [1]
        content {
          not_statement {
            statement {
              geo_match_statement {
                country_codes = var.allowed_countries
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name_prefix}-geo"
        sampled_requests_enabled   = var.enable_sampled_requests
      }
    }
  }

  dynamic "rule" {
    for_each = local.managed_rule_groups

    content {
      name     = "${var.name_prefix}-managed-${rule.key}"
      priority = rule.value.priority

      dynamic "override_action" {
        for_each = var.enforce ? [1] : []
        content {
          none {}
        }
      }
      dynamic "override_action" {
        for_each = var.enforce ? [] : [1]
        content {
          count {}
        }
      }

      statement {
        managed_rule_group_statement {
          name        = rule.value.name
          vendor_name = "AWS"

          dynamic "rule_action_override" {
            for_each = toset(rule.value.count_rules)
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }

          dynamic "rule_action_override" {
            for_each = toset(rule.value.captcha_rules)
            content {
              name = rule_action_override.value
              action_to_use {
                captcha {}
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name_prefix}-managed-${rule.key}"
        sampled_requests_enabled   = var.enable_sampled_requests
      }
    }
  }
}

resource "aws_wafv2_ip_set" "rate_limit_whitelist" {
  count = local.whitelist_enabled ? 1 : 0

  name               = "${var.name_prefix}-ip-rate-allow"
  description        = "Raised rate limit and geo exemption for ${var.name_prefix}"
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = var.rate_limit_whitelist_ips
}

resource "aws_wafv2_web_acl_association" "this" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

# Logging

resource "aws_cloudwatch_log_group" "waf" {
  # WAFv2 only accepts a destination log group whose name starts with
  # "aws-waf-logs-", and the name cannot be changed after creation.
  name              = "aws-waf-logs-${var.name_prefix}"
  retention_in_days = var.log_retention_in_days
  kms_key_id        = var.kms_key_id
}

resource "aws_wafv2_web_acl_logging_configuration" "waf" {
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  resource_arn            = aws_wafv2_web_acl.this.arn

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  redacted_fields {
    single_header {
      name = "cookiehub"
    }
  }
}

# Alarms

locals {
  # The notfi rule has no alarm: traffic from outside Finland tripping the limit
  # is background noise, while a Finnish user or a whitelisted office network
  # being captchad is something to look into.
  rate_limit_alarm_rules = merge(
    {
      fi = {
        rule        = "${var.name_prefix}-rate-limit-fi"
        description = "WAF Finland rate limit exceeded for ${var.name_prefix}"
      }
    },
    local.whitelist_enabled ? {
      whitelist = {
        rule        = "${var.name_prefix}-rate-limit-whitelist"
        description = "WAF whitelisted-IP rate limit exceeded for ${var.name_prefix}"
      }
    } : {}
  )
}

resource "aws_cloudwatch_metric_alarm" "rate_limit" {
  for_each = var.alarm_sns_topic_arn == null ? {} : local.rate_limit_alarm_rules

  alarm_name        = each.value.rule
  alarm_description = "${each.value.description}. ${var.enforce ? "These requests were served a CAPTCHA." : "The WAF is in COUNT mode, so these requests were served normally."} Check the WAF logs in CloudWatch Insights and decide whether the traffic is legitimate — if it is, allowlist the address or raise the limit."

  namespace   = "AWS/WAFV2"
  metric_name = var.enforce ? "CaptchaRequests" : "CountedRequests"

  # All three dimensions are required. Leaving one out yields a metric with no
  # data points, and an alarm that never fires.
  dimensions = {
    Region = local.region
    WebACL = aws_wafv2_web_acl.this.name
    Rule   = each.value.rule
  }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # The metric only has data points when the limit is exceeded; missing data
  # means no breach.
  treat_missing_data = "notBreaching"

  alarm_actions = [var.alarm_sns_topic_arn]
  ok_actions    = [var.alarm_sns_topic_arn]
}
