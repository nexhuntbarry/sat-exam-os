"use client";

import { useEffect } from "react";

/** Marks the whole document translate="no" while mounted. Chrome's
 *  auto-translate swaps React's text nodes for <font> wrappers, and React
 *  then crashes (insertBefore/removeChild NotFoundError) or shows stale
 *  text. The layout's meta tag covers full page loads; this covers client
 *  navigation into the test pages and content portaled into <body>. */
export default function NoTranslate() {
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.getAttribute("translate");
    html.setAttribute("translate", "no");
    return () => {
      if (prev === null) html.removeAttribute("translate");
      else html.setAttribute("translate", prev);
    };
  }, []);
  return null;
}
