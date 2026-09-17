import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Browser tests must not overwrite a running development instance's build.
  distDir: process.env.AW_TERMINAL_TEST_NEXT_DIR || '.next',
};

export default nextConfig;
