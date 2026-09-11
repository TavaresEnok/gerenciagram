/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Imagem standalone no Dockerfile de produção: sem isto a imagem final
  // precisaria do node_modules inteiro.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  eslint: { ignoreDuringBuilds: true },
  images: {
    remotePatterns: [
      // Avatares dos perfis vêm das CDNs das próprias redes.
      { protocol: 'https', hostname: '**.googleusercontent.com' },
      { protocol: 'https', hostname: '**.ggpht.com' },
      { protocol: 'https', hostname: '**.fbcdn.net' },
      { protocol: 'https', hostname: '**.cdninstagram.com' },
      { protocol: 'https', hostname: '**.tiktokcdn.com' },
      { protocol: 'https', hostname: '**.twimg.com' },
    ],
  },
};

export default nextConfig;
