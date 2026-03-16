import rateLimit from 'express-rate-limit';

/**
 * Rate limit on POST /api/meetings per user.
 * Limits each user to 10 meeting submissions per 15-minute window.
 */
export const rateLimitMiddleware = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    keyGenerator: (req) => {
        // Rate limit per authenticated user email
        return req.user?.email || req.ip || 'unknown';
    },
    message: { error: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
