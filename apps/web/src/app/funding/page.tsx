"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import TransakFunding from "@/components/TransakFunding";
import { StripeFunding } from "@/components/StripeFunding";
import { RowsSkeleton } from "@/components/Skeletons";
import { ErrorBanner, btnSecondary } from "@/components/ui";
import { api, errMsg, type FundingConfig } from "@/lib/api";
import { getToken } from "@/lib/session";
export default function FundingPage() {
  const { user, sessionKey } = useAuth();
  return <FundingProvider key={`${sessionKey}:${user?.wallet ?? ""}`} />;
}
function FundingProvider() {
  const { sessionKey } = useAuth();
  const [config, setConfig] = useState<FundingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    api.fundingConfig().then(value => { if (live && getToken() === sessionKey) setConfig(value); }).catch(cause => { if (live && getToken() === sessionKey) setError(errMsg(cause)); });
    return () => { live = false; };
  }, [sessionKey, attempt]);
  if (error) return <><ErrorBanner message={error} /><button className={btnSecondary} onClick={() => setAttempt(n => n + 1)}>Retry funding setup</button></>;
  if (!config) return <RowsSkeleton />;
  return config.provider === "stripe" ? <StripeFunding config={config} /> : <TransakFunding />;
}
