import { createApp } from './app.js'
import { env } from './env.js'

createApp().listen(env.port, '0.0.0.0', () => {
  console.log(`Hera API listening on http://0.0.0.0:${env.port}`)
})
