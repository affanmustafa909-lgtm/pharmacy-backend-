import 'dotenv/config'

function required(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

export const env = {
  databaseUrl: required('DATABASE_URL', 'postgresql://hera:hera@localhost:5436/hera'),
  jwtSecret: required('JWT_SECRET', 'dev-only-hera-secret-change-me'),
  port: Number(process.env.PORT ?? 4000),
}
