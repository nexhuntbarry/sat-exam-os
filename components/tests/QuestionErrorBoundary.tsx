"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  questionNumber?: number;
}

interface State {
  hasError: boolean;
}

export default class QuestionErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="rounded-2xl border border-status-error/30 bg-status-error/5 p-6 flex flex-col items-center gap-3 text-center">
        <AlertTriangle size={28} className="text-status-error/70" />
        <div>
          <p className="font-semibold text-charcoal">
            {this.props.questionNumber != null
              ? `Question ${this.props.questionNumber} failed to render.`
              : "This question failed to render."}
          </p>
          <p className="text-soft-mute text-sm mt-1">
            Use the question navigator at the bottom of the screen to skip to
            another question and continue your test.
          </p>
        </div>
      </div>
    );
  }
}
