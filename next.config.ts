import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Desenvolvimento pelo IP da rede (celular): libera os recursos de dev (/_next, HMR)
  // para origens de rede privada. Não afeta o build de produção.
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.*.*.*'],
}

export default nextConfig
