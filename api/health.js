// Visit /api/health in the browser to self-diagnose the Redis connection.
// Returns 200 with an `ok` boolean either way, so it's easy to read directly.
const { Redis } = require('@upstash/redis');

module.exports = async (req, res) => {
  const env = {
    UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
  };
  const hasVars = (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)
    || (env.KV_REST_API_URL && env.KV_REST_API_TOKEN);

  if (!hasVars) {
    return res.status(200).json({
      ok: false,
      stage: 'env',
      message: 'No Redis environment variables found on this deployment. In Vercel, connect the "Upstash for Redis" integration to this project (Storage tab or the Marketplace), then redeploy.',
      env,
    });
  }

  try {
    const redis = Redis.fromEnv();
    const key = '__health_check__';
    const payload = { t: Date.now() };
    await redis.set(key, payload, { ex: 30 });
    const roundtrip = await redis.get(key);
    return res.status(200).json({ ok: true, stage: 'redis', message: 'Redis connection is working.', roundtrip, env });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      stage: 'redis',
      message: 'Environment variables are present but the Redis call failed.',
      error: String((e && e.message) || e),
      env,
    });
  }
};
