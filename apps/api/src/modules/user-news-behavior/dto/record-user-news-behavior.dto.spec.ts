import { BadRequestException } from "@nestjs/common";

import {
  validateRecordUserNewsBehaviorDto,
  type RecordUserNewsBehaviorDto,
} from "./record-user-news-behavior.dto";

describe("validateRecordUserNewsBehaviorDto", () => {
  it("requires itemId for reading milestone events", () => {
    const input = {
      type: "deep_read",
    } as RecordUserNewsBehaviorDto;

    expect(() => validateRecordUserNewsBehaviorDto(input)).toThrow(
      BadRequestException,
    );
  });

  it("rejects not_interested payloads with multiple target families", () => {
    const input = {
      type: "not_interested",
      itemId: "item-1",
      source: "reuters",
    } as RecordUserNewsBehaviorDto;

    expect(() => validateRecordUserNewsBehaviorDto(input)).toThrow(
      BadRequestException,
    );
  });

  it("accepts not_interested payloads with a single item target", () => {
    const input = {
      type: "not_interested",
      itemId: "item-1",
    } as RecordUserNewsBehaviorDto;

    expect(() => validateRecordUserNewsBehaviorDto(input)).not.toThrow();
  });

  it("requires unsubscribe payloads to target exactly one topic or entity", () => {
    const invalid = {
      type: "unsubscribe",
      topics: ["ai"],
      entities: ["openai"],
    } as RecordUserNewsBehaviorDto;
    const valid = {
      type: "unsubscribe",
      topics: ["ai"],
    } as RecordUserNewsBehaviorDto;

    expect(() => validateRecordUserNewsBehaviorDto(invalid)).toThrow(
      BadRequestException,
    );
    expect(() => validateRecordUserNewsBehaviorDto(valid)).not.toThrow();
  });
});
