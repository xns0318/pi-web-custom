export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Warm and maintain usage even when no browser or usage panel is open.
  // Do not scan a developer's session store while producing build artifacts.
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    const { getUsageService } = await import("@/lib/usage-runtime");
    getUsageService();
  }
}
