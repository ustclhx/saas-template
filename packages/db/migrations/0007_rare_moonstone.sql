-- rollback-safe: 仅新增可空 provider_refund_id 列，旧代码可继续省略该列
ALTER TABLE "refund_request" ADD COLUMN "provider_refund_id" text;