import type { FastifyInstance } from 'fastify';

// The policy itself lives on the marketing site, which is the canonical copy and
// the one the Chrome Web Store listing links to. This route used to serve its own
// hand-maintained HTML, which silently kept describing the retired "Volley" product
// after the extension became RoleQuick, so the store listing pointed at a policy for
// the wrong product. Redirect instead of duplicating: one policy, one place to edit.
const CANONICAL_PRIVACY_URL = 'https://role-quick-website.vercel.app/privacy';

export async function privacyRoutes(fastify: FastifyInstance) {
  fastify.get('/privacy', async (_request, reply) => {
    return reply.redirect(CANONICAL_PRIVACY_URL, 301);
  });
}
