import { z } from 'zod';

/**
 * Contrato de variables de entorno. Se valida al arrancar: si falta algo o viene
 * malformado, el proceso no levanta en vez de fallar más tarde en producción.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_TIMEZONE: z.string().default('America/Mexico_City'),

    DATABASE_URL: z.string().url(),

    // 'stub' registra los envíos en el log en vez de llamar a Meta: permite
    // desarrollar y probar todo el sistema sin credenciales ni costo.
    WHATSAPP_DRIVER: z.enum(['stub', 'cloud-api']).default('stub'),
    WHATSAPP_API_VERSION: z.string().default('v21.0'),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(1),

    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

    JWT_SECRET: z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('12h'),
  })
  .superRefine((env, ctx) => {
    if (env.WHATSAPP_DRIVER !== 'cloud-api') return;
    // Con el driver real, estas credenciales dejan de ser opcionales.
    const required = [
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_APP_SECRET',
    ] as const;
    for (const key of required) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} es obligatorio cuando WHATSAPP_DRIVER=cloud-api`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${detail}`);
  }
  return result.data;
}
