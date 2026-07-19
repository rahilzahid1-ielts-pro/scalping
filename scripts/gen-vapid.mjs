/**
 * Generate a VAPID key pair for Web Push. Run once:
 *   node scripts/gen-vapid.mjs
 *
 * Then set these as environment variables (Railway → Variables, or local .env):
 *   WEB_PUSH_VAPID_PUBLIC_KEY   = <public key printed below>
 *   WEB_PUSH_VAPID_PRIVATE_KEY  = <private key printed below>   (keep secret!)
 *   WEB_PUSH_CONTACT            = mailto:you@example.com        (optional)
 *
 * The public key is served to the browser via GET /api/push/public-key.
 * Never commit the private key.
 */
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log("\n=== VAPID keys generated ===\n");
console.log("WEB_PUSH_VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("WEB_PUSH_VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("\nAdd both to your environment. Keep the PRIVATE key secret.\n");
