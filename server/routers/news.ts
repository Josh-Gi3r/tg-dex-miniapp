/**
 * News Router
 *
 * Fetches articles from the configured news API (NEWS_API_URL) via its
 * public tRPC endpoint. Results are cached server-side for 15 minutes so the
 * Mini App never hammers the upstream API and new articles appear automatically
 * within one cache cycle.
 *
 * Endpoint: GET NEWS_API_URL (set in env)
 * Article URL: NEWS_BASE_URL/{slug}
 */

import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawNewsArticle {
  id: number;
  title: string;
  slug: string;
  excerpt: string;
  category: string;
  author: string;
  publishedAt: string;
  featured: number;
  status: string;
  image: string | null;
  source: string | null;
  readTime: string | null;
  likeCount: number;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewsArticle {
  id: number;
  title: string;
  slug: string;
  excerpt: string;
  category: string;
  author: string;
  publishedAt: string;
  featured: boolean;
  imageUrl: string | null;
  readTime: string | null;
  url: string;
}

// ---------------------------------------------------------------------------
// In-memory cache (15 minutes TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const NEWS_API_URL = process.env.NEWS_API_URL ?? "";
const NEWS_BASE_URL = process.env.NEWS_BASE_URL ?? "";

let cachedArticles: NewsArticle[] | null = null;
let cacheTimestamp = 0;

/**
 * Fetch articles from NEWS_API_URL, using the in-memory cache if still fresh.
 * Returns the most recent articles sorted by publishedAt descending.
 */
async function fetchArticles(): Promise<NewsArticle[]> {
  const now = Date.now();

  // Return cached data if still fresh
  if (cachedArticles && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedArticles;
  }

  let raw: RawNewsArticle[] = [];
  try {
    const res = await fetch(NEWS_API_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });

    if (!res.ok) {
      throw new Error(`news API returned ${res.status}`);
    }

    const body = (await res.json()) as {
      result?: { data?: { json?: RawNewsArticle[] } };
    };
    raw = body?.result?.data?.json ?? [];
  } catch (err) {
    // Graceful degrade: when NEWS_API_URL is unreachable (sandbox egress
    // restrictions or genuine outage), return the previous cache if any,
    // or an empty list. The UI shows "no articles right now" instead of
    // a 500 banner.
    console.warn("[news.fetchArticles] upstream unreachable:", err);
    if (cachedArticles) return cachedArticles;
    cachedArticles = [];
    cacheTimestamp = now;
    return cachedArticles;
  }

  // Normalise and filter to published articles only
  const articles: NewsArticle[] = raw
    .filter((a) => a.status === "published")
    .map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      excerpt: a.excerpt ?? "",
      category: a.category ?? "NEWS",
      author: a.author ?? "Editorial Team",
      publishedAt: a.publishedAt,
      featured: a.featured === 1,
      imageUrl: a.image ?? null,
      readTime: a.readTime ?? null,
      url: `${NEWS_BASE_URL}/${a.slug}`,
    }))
    // Sort newest first
    .sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );

  // Update cache
  cachedArticles = articles;
  cacheTimestamp = now;

  return articles;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const newsRouter = router({
  /**
   * Get the latest news articles from the configured news API.
   *
   * @param limit  - Number of articles to return (default 20, max 50)
   * @param category - Optional category filter (e.g. "CORPORATE NEWS", "MARKET NEWS")
   * @param featuredOnly - If true, return only featured articles
   */
  getArticles: publicProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(50).default(20),
        category: z.string().optional(),
        featuredOnly: z.boolean().default(false),
      })
    )
    .query(async ({ input }) => {
      const all = await fetchArticles();

      let filtered = all;

      if (input.featuredOnly) {
        filtered = filtered.filter((a) => a.featured);
      }

      if (input.category) {
        filtered = filtered.filter(
          (a) => a.category.toUpperCase() === input.category!.toUpperCase()
        );
      }

      return {
        articles: filtered.slice(0, input.limit),
        total: filtered.length,
        cachedAt: new Date(cacheTimestamp).toISOString(),
      };
    }),

  /**
   * Get the list of distinct categories from the current article set.
   * Useful for the category filter UI.
   */
  getCategories: publicProcedure.query(async () => {
    const all = await fetchArticles();
    const cats = Array.from(new Set(all.map((a) => a.category))).sort();
    return cats;
  }),

  /**
   * Force-invalidate the server-side cache.
   * Useful for testing or when you know a new article was just published.
   */
  invalidateCache: publicProcedure.mutation(() => {
    cachedArticles = null;
    cacheTimestamp = 0;
    return { success: true };
  }),
});
