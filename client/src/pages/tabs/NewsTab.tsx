import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useTelegram } from "@/contexts/TelegramContext";
import { InfoChip } from "@/components/onboarding/InfoChip";

// Category colour map -- keeps the UI consistent regardless of what the news API returns
const CATEGORY_COLORS: Record<string, string> = {
  "CORPORATE NEWS": "#4A90D9",
  "MARKET NEWS": "#00C896",
  "REGULATORY NEWS": "#D4A017",
  "REGULATION": "#D4A017",
  "TECHNOLOGY": "#9B59B6",
  "TECH": "#9B59B6",
  "ANALYSIS": "#9B59B6",
  "FEATURE": "#D4A017",
  "APP": "#00C896",
  "NEWS": "#00C896",
};

function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat.toUpperCase()] ?? "#8E8E93";
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------
function ArticleSkeleton() {
  return (
    <div style={{ padding: "15px 16px", borderBottom: "0.5px solid rgba(60,60,67,0.10)" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <div style={{ width: 80, height: 18, borderRadius: 20, background: "rgba(60,60,67,0.08)" }} />
        <div style={{ width: 60, height: 18, borderRadius: 20, background: "rgba(60,60,67,0.05)" }} />
      </div>
      <div style={{ width: "90%", height: 16, borderRadius: 6, background: "rgba(60,60,67,0.08)", marginBottom: 6 }} />
      <div style={{ width: "70%", height: 16, borderRadius: 6, background: "rgba(60,60,67,0.06)" }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function NewsTab() {
  const { webApp } = useTelegram();
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>(undefined);

  const { data, isLoading, isError, refetch } = trpc.news.getArticles.useQuery(
    { limit: 30, category: selectedCategory },
    { staleTime: 10 * 60 * 1000 } // treat data as fresh for 10 min on the client
  );

  const { data: categories } = trpc.news.getCategories.useQuery(undefined, {
    staleTime: 30 * 60 * 1000,
  });

  const handleOpen = (url: string) => {
    if (webApp?.openLink) webApp.openLink(url);
    else window.open(url, "_blank");
  };

  const articles = data?.articles ?? [];
  const featured = articles.find((a) => a.featured);
  const rest = articles.filter((a) => !a.featured);

  return (
    <div className="tab-page">

      {/* Header */}
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="page-title">News</div>
              <InfoChip topic="news" compact />
            </div>
            <div className="page-subtitle">Latest News</div>
          </div>
          <button
            onClick={() => handleOpen(import.meta.env.VITE_NEWS_BASE_URL ?? "https://example.com/news")}
            style={{
              background: "rgba(118,118,128,0.10)",
              border: "0.5px solid rgba(60,60,67,0.15)",
              borderRadius: 20, padding: "6px 14px",
              fontSize: 13, fontWeight: 600, color: "#3C3C43", cursor: "pointer",
            }}
          >
            All News
          </button>
        </div>
      </div>

      <div className="tab-content">

        {/* Category filter pills */}
        {categories && categories.length > 0 && (
          <div style={{
            display: "flex", gap: 8, overflowX: "auto",
            paddingBottom: 4, scrollbarWidth: "none",
          }}>
            <button
              onClick={() => setSelectedCategory(undefined)}
              style={{
                flexShrink: 0, padding: "5px 14px", borderRadius: 20,
                fontSize: 12, fontWeight: 600, cursor: "pointer",
                border: selectedCategory === undefined
                  ? "1px solid #00C896"
                  : "0.5px solid rgba(60,60,67,0.15)",
                background: selectedCategory === undefined
                  ? "rgba(0,200,150,0.10)"
                  : "rgba(118,118,128,0.08)",
                color: selectedCategory === undefined ? "#00C896" : "#3C3C43",
              }}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat === selectedCategory ? undefined : cat)}
                style={{
                  flexShrink: 0, padding: "5px 14px", borderRadius: 20,
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: selectedCategory === cat
                    ? `1px solid ${categoryColor(cat)}`
                    : "0.5px solid rgba(60,60,67,0.15)",
                  background: selectedCategory === cat
                    ? `${categoryColor(cat)}18`
                    : "rgba(118,118,128,0.08)",
                  color: selectedCategory === cat ? categoryColor(cat) : "#3C3C43",
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Error state */}
        {isError && (
          <div style={{
            background: "rgba(255,59,48,0.06)",
            border: "0.5px solid rgba(255,59,48,0.20)",
            borderRadius: 16, padding: 20, textAlign: "center",
          }}>
            <div style={{ fontSize: 14, color: "#FF3B30", fontWeight: 600, marginBottom: 8 }}>
              Could not load articles
            </div>
            <button
              onClick={() => refetch()}
              style={{
                background: "rgba(255,59,48,0.10)", border: "none",
                borderRadius: 12, padding: "8px 20px",
                fontSize: 13, fontWeight: 600, color: "#FF3B30", cursor: "pointer",
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div style={{
            background: "#FFFFFF", borderRadius: 16,
            border: "0.5px solid rgba(60,60,67,0.12)",
            boxShadow: "0 2px 20px rgba(0,0,0,0.06)",
            overflow: "hidden",
          }}>
            {[...Array(6)].map((_, i) => <ArticleSkeleton key={i} />)}
          </div>
        )}

        {/* Featured article */}
        {!isLoading && featured && (
          <button
            onClick={() => handleOpen(featured.url)}
            style={{
              width: "100%", textAlign: "left",
              background: "rgba(0,200,150,0.06)",
              border: "0.5px solid rgba(0,200,150,0.25)",
              borderRadius: 20,
              boxShadow: "0 4px 24px rgba(0,200,150,0.10)",
              padding: 0, cursor: "pointer", overflow: "hidden",
            }}
          >
            {/* Article image */}
            {featured.imageUrl && (
              <img
                src={featured.imageUrl}
                alt={featured.title}
                style={{
                  width: "100%", height: 160, objectFit: "cover",
                  display: "block",
                }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            )}
            <div style={{ padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
                  color: "#00C896", textTransform: "uppercase",
                  background: "rgba(0,200,150,0.10)",
                  border: "0.5px solid rgba(0,200,150,0.30)",
                  padding: "3px 9px", borderRadius: 20,
                }}>
                  FEATURED
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
                  color: categoryColor(featured.category), textTransform: "uppercase",
                  background: `${categoryColor(featured.category)}14`,
                  border: `0.5px solid ${categoryColor(featured.category)}44`,
                  padding: "3px 9px", borderRadius: 20,
                }}>
                  {featured.category}
                </span>
              </div>
              <div style={{
                fontWeight: 700, fontSize: 17, color: "#1C1C1E",
                lineHeight: 1.35, marginBottom: 8, letterSpacing: "-0.01em",
              }}>
                {featured.title}
              </div>
              <div style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.55, marginBottom: 12 }}>
                {featured.excerpt}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, color: "#8E8E93" }}>
                  {formatDate(featured.publishedAt)}{featured.readTime ? ` · ${featured.readTime}` : ""}
                </span>
                <span style={{ fontSize: 13, color: "#00C896", fontWeight: 600 }}>
                  Read more
                </span>
              </div>
            </div>
          </button>
        )}

        {/* Article list */}
        {!isLoading && rest.length > 0 && (
          <>
            <div className="section-title" style={{ marginBottom: 10 }}>Latest Stories</div>
            <div style={{
              background: "#FFFFFF", borderRadius: 16,
              border: "0.5px solid rgba(60,60,67,0.12)",
              boxShadow: "0 2px 20px rgba(0,0,0,0.06)",
              overflow: "hidden",
            }}>
              {rest.map((article, i) => (
                <button
                  key={article.id}
                  onClick={() => handleOpen(article.url)}
                  style={{
                    width: "100%", textAlign: "left", background: "transparent",
                    border: "none",
                    borderBottom: i < rest.length - 1 ? "0.5px solid rgba(60,60,67,0.10)" : "none",
                    padding: "15px 16px", cursor: "pointer",
                    display: "flex", gap: 12, alignItems: "flex-start",
                  }}
                >
                  {/* Thumbnail */}
                  {article.imageUrl && (
                    <img
                      src={article.imageUrl}
                      alt={article.title}
                      style={{
                        width: 64, height: 64, borderRadius: 10,
                        objectFit: "cover", flexShrink: 0,
                      }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
                        color: categoryColor(article.category), textTransform: "uppercase",
                        background: `${categoryColor(article.category)}14`,
                        border: `0.5px solid ${categoryColor(article.category)}44`,
                        padding: "2px 8px", borderRadius: 20, flexShrink: 0,
                      }}>
                        {article.category}
                      </span>
                      <span style={{ fontSize: 11, color: "#AEAEB2" }}>
                        {formatDate(article.publishedAt)}
                        {article.readTime ? ` · ${article.readTime}` : ""}
                      </span>
                    </div>
                    <div style={{
                      fontWeight: 600, fontSize: 14, color: "#1C1C1E",
                      lineHeight: 1.35, marginBottom: 5,
                    }}>
                      {article.title}
                    </div>
                    <div style={{
                      fontSize: 12, color: "#8E8E93", lineHeight: 1.5,
                      display: "-webkit-box", WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical", overflow: "hidden",
                    }}>
                      {article.excerpt}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, color: "#AEAEB2", fontSize: 18, marginTop: 2 }}>›</div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Empty state */}
        {!isLoading && !isError && articles.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: "#8E8E93" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📰</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#3C3C43", marginBottom: 6 }}>
              No articles found
            </div>
            <div style={{ fontSize: 13 }}>
              {selectedCategory
                ? `No articles in "${selectedCategory}" right now.`
                : "Check back soon for the latest stablecoin news."}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ textAlign: "center" }}>
          <button
            onClick={() => handleOpen(import.meta.env.VITE_NEWS_BASE_URL ?? "https://example.com/news")}
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 14, color: "#8E8E93", fontWeight: 600,
            }}
          >
            More news
          </button>
        </div>

      </div>
    </div>
  );
}
