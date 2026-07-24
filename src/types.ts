export type Topic = "Tech/AI" | "Geopolitics";

export type Source = "NYT" | "BBC" | "TechCrunch";

export interface Article {
  title: string;
  snippet: string;
  url: string;
  source: Source;
  topic: Topic;
  publishedAt: string;
}

export interface Cluster {
  topic: Topic;
  articles: Article[];
}

export interface Card {
  topic: Topic;
  shortSummary: string;
  sources: Pick<Article, "title" | "url" | "source">[];
}
