"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/providers/AuthProvider";

export function OpsGuard({ children }: { children: React.ReactNode }) {
  const { operator, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !operator) {
      router.replace("/login");
    }
  }, [operator, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (!operator) return null;

  return <>{children}</>;
}
