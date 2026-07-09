# Shared helpers for multi-file-demo.verse. The IDE compiles every file
# in the workspace together (one shared module scope), so other files can
# call these directly — no import needed for same-workspace definitions.

GoldenRatio : float = 1.618034

Average(A : float, B : float) : float = (A + B) / 2.0

Lerp(A : float, B : float, T : float) : float = A + (B - A) * T
