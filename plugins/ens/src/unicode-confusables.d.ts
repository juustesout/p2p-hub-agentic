declare module "unicode-confusables" {
  export interface ConfusablePoint {
    point: string;
    similarTo?: string;
  }
  export const isConfusing: (input: string) => boolean;
  export const confusables: (input: string) => ConfusablePoint[];
  export const rectifyConfusion: (input: string) => string;
}
