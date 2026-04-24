"use client";

interface PDFViewerProps {
  url: string;
  page?: number;
  className?: string;
}

export default function PDFViewer({ url, page = 1, className }: PDFViewerProps) {
  const src = page > 1 ? `${url}#page=${page}` : url;

  return (
    <iframe
      src={src}
      className={className ?? "w-full h-full min-h-[600px] rounded-xl border border-white/8"}
      title={`PDF page ${page}`}
    />
  );
}
