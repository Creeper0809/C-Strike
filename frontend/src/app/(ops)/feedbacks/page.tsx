import { redirect } from "next/navigation";

export default function FeedbacksPage() {
  redirect("/tickets?tab=feedback");
}
