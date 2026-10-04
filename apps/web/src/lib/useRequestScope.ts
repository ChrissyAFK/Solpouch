"use client";
import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@/components/AuthProvider";
import { getToken } from "./session";

/** Every refresh supersedes older requests and is confined to its login session. */
export function useRequestScope() {
  const { sessionKey } = useAuth();
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  return useCallback(() => {
    const current = ++generation.current;
    return () => mounted.current && generation.current === current && getToken() === sessionKey;
  }, [sessionKey]);
}
