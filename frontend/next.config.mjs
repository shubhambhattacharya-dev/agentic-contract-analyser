/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev convenience: proxy API calls to the local backend so the browser talks
  // same-origin. In production, NEXT_PUBLIC_API_URL points directly at the
  // backend deployment (CORS + SameSite=None cookie are configured there).
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8000/api/:path*",
      },
      {
        source: "/health",
        destination: "http://127.0.0.1:8000/health",
      },
    ];
  },
};

export default nextConfig;
