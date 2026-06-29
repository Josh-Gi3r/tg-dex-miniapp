/**
 * seed-changers.mjs — lightweight standalone script to insert a few demo
 * money-changer profiles directly into the database.
 *
 * For a richer seed dataset (22 changers, P2P ads, managed wallets) run the
 * in-app seed endpoint instead: POST /api/admin/seed (requires FEATURE_MAINNET=false).
 *
 * Usage: node seed-changers.mjs
 * Requires: DATABASE_URL in .env or env
 */

import mysql from 'mysql2/promise';

// ─── Demo personas ────────────────────────────────────────────────────────────
// Replace or extend with your own changer profiles.
// Bios should NOT contain external Telegram handles — the app generates its own
// deep links based on the user's registered handle.
const changers = [
  {
    displayName: "Global Crypto SG",
    bio: "USDT to SGD cash in Singapore. No KYC. Fast settlement.",
    isActive: 1,
    reputationScore: 98.5,
    avgRating: 4.9,
    totalRatings: 1247,
    completionRate: 99.2,
    totalOrdersFilled: 1312,
    totalVolumeUsd: 4850000.00,
  },
  {
    displayName: "Quick Pay SG",
    bio: "Fast and instant payments. Cash deposit & bank transfer Singapore.",
    isActive: 1,
    reputationScore: 97.8,
    avgRating: 4.89,
    totalRatings: 2301,
    completionRate: 98.7,
    totalOrdersFilled: 2389,
    totalVolumeUsd: 7200000.00,
  },
  {
    displayName: "P2P Handler SG",
    bio: "Fast response. Bank transfer Singapore. New users welcome.",
    isActive: 1,
    reputationScore: 96.4,
    avgRating: 4.92,
    totalRatings: 82,
    completionRate: 94.5,
    totalOrdersFilled: 87,
    totalVolumeUsd: 320000.00,
  },
  {
    displayName: "Fast Buy MYR",
    bio: "Malaysia P2P specialist. Maybank & CIMB. Requires verification for large orders.",
    isActive: 1,
    reputationScore: 95.1,
    avgRating: 4.75,
    totalRatings: 306,
    completionRate: 93.1,
    totalOrdersFilled: 329,
    totalVolumeUsd: 980000.00,
  },
  {
    displayName: "KL Crypto Desk",
    bio: "Kuala Lumpur based. USDT to MYR via Maybank, RHB, and cash. Fast 15 min response.",
    isActive: 1,
    reputationScore: 97.2,
    avgRating: 4.88,
    totalRatings: 541,
    completionRate: 97.8,
    totalOrdersFilled: 553,
    totalVolumeUsd: 1650000.00,
  },
  {
    displayName: "Cloud OTC SG",
    bio: "Face-to-face cash OTC in person. Singapore. Clean funds only. 700+ trades.",
    isActive: 1,
    reputationScore: 94.3,
    avgRating: 4.71,
    totalRatings: 700,
    completionRate: 96.4,
    totalOrdersFilled: 726,
    totalVolumeUsd: 2100000.00,
  },
];

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const conn = await mysql.createConnection(dbUrl);

  // Insert a system user if not exists to own the changer profiles
  const [userRows] = await conn.execute(
    "SELECT id FROM users WHERE openId = 'system_seed' LIMIT 1"
  );

  let systemUserId;
  if (userRows.length === 0) {
    const [result] = await conn.execute(
      "INSERT INTO users (openId, name, email, role) VALUES (?, ?, ?, ?)",
      ['system_seed', 'System', 'system@example.local', 'user']
    );
    systemUserId = result.insertId;
  } else {
    systemUserId = userRows[0].id;
  }

  for (const c of changers) {
    await conn.execute(
      `INSERT INTO changer_profiles
        (userId, displayName, bio, isActive, reputationScore, avgRating, totalRatings, completionRate, totalOrdersFilled, totalVolumeUsd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [systemUserId, c.displayName, c.bio, c.isActive, c.reputationScore, c.avgRating, c.totalRatings, c.completionRate, c.totalOrdersFilled, c.totalVolumeUsd]
    );
    console.log(`Seeded: ${c.displayName}`);
  }

  await conn.end();
  console.log('Done seeding changer profiles.');
}

main().catch(console.error);
