import corpusCatalog from "../../../docs/corpus-samples.json";
export interface CorpusSource {
  category: string;
  color: string;
  documents: number;
  repo: string;
  revision: string;
  url: string;
  previous_ids?: string[];
  [key: string]: unknown;
}
export const corpusSources: Record<string, CorpusSource> = Object.fromEntries(
  corpusCatalog.map((source) => [source.id, source]),
);
export const learningExamples = [
  {
    id: "healthy",
    group: "healthy",
    title: "Healthy learning",
    tag: "Expected pattern",
    train: [5.5, 4.6, 3.9, 3.4, 3.05, 2.8, 2.6, 2.45, 2.35, 2.28, 2.22],
    val: [5.6, 4.8, 4.15, 3.75, 3.45, 3.25, 3.1, 3.0, 2.95, 2.91, 2.89],
    observation:
      "Both curves decrease, with a moderate gap between them. Validation improvements gradually slow down.",
    action:
      "Continue while validation improves within your budget. Compare checkpoints on the same dataset and reserve an independent final test.",
    trap: "A training–validation gap alone does not indicate a problem. Look at the trend and whether validation represents the intended use.",
  },
  {
    id: "overfit",
    group: "problem",
    title: "Overfitting",
    tag: "Training and validation diverge",
    train: [
      5.6, 1.55, 0.08, 0.015, 0.006, 0.003, 0.002, 0.0015, 0.0013, 0.0012,
      0.0011,
    ],
    val: [4.9, 3.85, 4.95, 5.45, 5.7, 5.9, 6.05, 6.25, 6.4, 6.6, 6.76],
    observation:
      "Training loss approaches zero, but validation loss rises after an initial improvement. The model is memorizing the training data.",
    action:
      "Choose the checkpoint with the lowest validation loss and stop training earlier. Add diverse data, remove duplicates, and try a smaller model or regularization.",
    trap: "Millions of processed tokens may be thousands of repetitions of the same short text. More steps do not necessarily mean more knowledge.",
  },
  {
    id: "underfit",
    group: "problem",
    title: "Underfitting or failure to learn",
    tag: "Both curves are nearly flat",
    train: [5.5, 5.42, 5.38, 5.35, 5.34, 5.33, 5.32, 5.31, 5.3, 5.3, 5.29],
    val: [5.55, 5.49, 5.47, 5.45, 5.44, 5.45, 5.43, 5.44, 5.42, 5.43, 5.42],
    observation:
      "Training and validation remain close to their initial levels. A small gap does not indicate a good model here.",
    action:
      "Check label shifting, masks, gradients, and weight updates. Try deliberately overfitting a tiny batch before adjusting the learning rate, training duration, or model size.",
    trap: "There is no universal threshold for good loss. Its level depends on the tokenizer, data, and calculation method; you need a baseline.",
  },
  {
    id: "unstable",
    group: "problem",
    title: "Unstable training",
    tag: "Spikes and exploding loss",
    train: [5.5, 4.6, 4.1, 5.8, 3.9, 7.4, 5.2, 9, 11, 14, 18],
    val: [5.6, 4.8, 4.5, 5.6, 4.8, 7.1, 6.4, 9.7, 12, 15, 19],
    observation:
      "Large spikes turn into increasing loss. A real run may also produce NaN or Inf values.",
    action:
      "Check gradient norms, learning rate, warmup, and numerical precision. Lower the learning rate, consider gradient clipping, and inspect the batch preceding the spike.",
    trap: "Do not smooth away the problem. Inspect the raw measurements; a single spike may have a different cause from sustained divergence.",
  },
  {
    id: "noisy",
    group: "healthy",
    title: "Noise with a healthy trend",
    tag: "Uneven does not mean broken",
    train: [5.5, 4.3, 4.7, 3.7, 4.1, 3.2, 3.55, 2.85, 3.1, 2.55, 2.7],
    val: [5.6, 4.95, 4.65, 4.4, 4.05, 3.9, 3.6, 3.5, 3.25, 3.1, 3.05],
    observation:
      "Batch losses fluctuate, but validation loss and the overall trend decrease. Batches can differ in difficulty.",
    action:
      "Look at several consecutive evaluations, not a single point. Use a fixed validation set and increase its size if necessary. Smoothing helps reveal the trend, but retain the raw values.",
    trap: "Do not change the configuration after every fluctuation. Sustained validation degradation is different from batch noise.",
  },
  {
    id: "leakage",
    group: "problem",
    title: "Suspiciously good validation",
    tag: "Check the data and metric",
    train: [5.5, 3.8, 2.6, 1.6, 0.8, 0.4, 0.18, 0.09, 0.05, 0.03, 0.02],
    val: [5.45, 3.78, 2.55, 1.57, 0.79, 0.39, 0.17, 0.085, 0.048, 0.029, 0.019],
    observation:
      "Validation closely tracks training and becomes very low. This could indicate an easy task, data leakage, or an evaluation error.",
    action:
      "Check for shared documents, duplicates, and fragments from the same source across the split. Verify labels and masking, then evaluate on independent data.",
    trap: "The chart alone does not prove leakage. Splitting one document into 90/10 token segments tests generalization less reliably than separating independent documents.",
  },
];
