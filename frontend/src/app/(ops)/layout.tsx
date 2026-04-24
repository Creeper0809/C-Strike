import { OpsGuard } from "@/components/ops/OpsGuard";
import { OpsSidebar } from "@/components/ops/OpsSidebar";

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return (
    <OpsGuard>
      <div className="flex h-screen overflow-hidden">
        <OpsSidebar />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </OpsGuard>
  );
}
