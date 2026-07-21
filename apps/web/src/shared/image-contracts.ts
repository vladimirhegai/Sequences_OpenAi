import { z } from "zod";

export const ImageInputV1Schema = z
  .object({
    path: z.string().regex(/^assets\/derived\/input-[0-9a-f]{32}\.(?:png|jpg|webp)$/),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    bytes: z
      .number()
      .int()
      .positive()
      .max(15 * 1_024 * 1_024),
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const ImageInputResponseV1Schema = z
  .object({
    version: z.literal("sequences.image-input.v1"),
    image: ImageInputV1Schema,
  })
  .strict();

export type ImageInputV1 = z.infer<typeof ImageInputV1Schema>;
export type ImageInputResponseV1 = z.infer<typeof ImageInputResponseV1Schema>;
