process.env.NODE_ENV = 'test';
process.env.APP_TIMEZONE = process.env.APP_TIMEZONE ?? 'America/Mexico_City';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://ppeam:ppeam@localhost:5433/ppeam_schedules_test?schema=public';
process.env.WHATSAPP_DRIVER = 'stub';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';
process.env.JWT_SECRET = 'test-secret-que-es-suficientemente-largo';
