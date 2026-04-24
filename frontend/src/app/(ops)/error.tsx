"use client";

export default function OpsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h2 className="text-lg font-semibold text-status-danger">페이지 오류</h2>
      <pre className="text-xs text-text-secondary bg-bg-secondary border border-border rounded-lg p-4 max-w-lg overflow-auto whitespace-pre-wrap">
        {error.message}
        {error.stack && "\n\n" + error.stack}
      </pre>
      <button
        onClick={reset}
        className="px-4 py-2 bg-accent text-white text-sm rounded-lg hover:bg-accent-hover"
      >
        다시 시도
      </button>
    </div>
  );
}
