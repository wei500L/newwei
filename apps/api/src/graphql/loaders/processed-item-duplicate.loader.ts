import { asLeanRecords, leanId, ProcessedItemModel } from "@modular/mongo";
import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";
import { Types } from "mongoose";


/**
 * DataLoader for resolving ProcessedItem._id to its ItemMeta id.
 *
 * `ProcessedItem.duplicateOf` references another ProcessedItem document
 * (`ref: "ProcessedItem"`), but consumers (list cards, detail page) navigate
 * with the target's ItemMeta id. This loader performs the cross-ID-space
 * resolution in one batched query.
 */
@Injectable({ scope: Scope.REQUEST })
export class ProcessedItemDuplicateLoader {
  private readonly loaderByOrgId = new Map<string, DataLoader<string, string | null>>();

  generateDataLoader(orgId: string): DataLoader<string, string | null> {
    const existing = this.loaderByOrgId.get(orgId);
    if (existing) {
      return existing;
    }

    const loader = new DataLoader<string, string | null>(async (processedItemIds) => {
      const validIds = (processedItemIds as string[]).filter((id) =>
        Types.ObjectId.isValid(id),
      );
      if (validIds.length === 0) {
        return (processedItemIds as string[]).map(() => null);
      }

      const docs = asLeanRecords(
        await ProcessedItemModel.find({
          _id: { $in: validIds },
          orgId,
        })
          .select({ itemMetaId: 1 })
          .lean(),
      );

      const itemMetaIdByProcessedItemId = new Map<string, string>();
      for (const doc of docs) {
        const id = leanId(doc._id) ?? "";
        const itemMetaId =
          typeof doc.itemMetaId === "string" ? doc.itemMetaId.trim() : "";
        if (id && itemMetaId) {
          itemMetaIdByProcessedItemId.set(id, itemMetaId);
        }
      }

      return (processedItemIds as string[]).map((id) => {
        if (!Types.ObjectId.isValid(id)) {
          return null;
        }
        return itemMetaIdByProcessedItemId.get(id) ?? null;
      });
    });

    this.loaderByOrgId.set(orgId, loader);
    return loader;
  }
}
