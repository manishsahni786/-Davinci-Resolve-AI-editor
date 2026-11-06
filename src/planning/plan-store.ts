import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureDir, writeTextFileAtomic } from "../utils/file-utils.js";
import {
  approveEditingPlan,
  createEditingPlan,
  EditingPlanSchema,
  markEditingPlanExecuting,
  markEditingPlanExecuted,
  reviseEditingPlan,
  type EditingPlan
} from "./editing-plan.js";

const PLAN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export class EditingPlanStore {
  private readonly plansDirectory: string;

  constructor(dataDirectory: string) {
    this.plansDirectory = path.join(dataDirectory, "plans");
  }

  async create(draft: unknown): Promise<EditingPlan> {
    const plan = createEditingPlan(draft, randomUUID());
    await this.save(plan);
    return plan;
  }

  async get(planId: string): Promise<EditingPlan> {
    const file = this.planPath(planId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error(`Editing plan not found: ${planId}`);
      }
      throw error;
    }
    return EditingPlanSchema.parse(parsed);
  }

  async revise(planId: string, expectedRevision: number, changes: unknown): Promise<EditingPlan> {
    const current = await this.get(planId);
    this.assertRevision(current, expectedRevision);
    if (current.status === "executed") {
      throw new Error("An executed plan cannot be revised. Create a new plan for further edits.");
    }
    const revised = reviseEditingPlan(current, changes);
    await this.save(revised);
    return revised;
  }

  async approve(planId: string, expectedRevision: number): Promise<EditingPlan> {
    const current = await this.get(planId);
    this.assertRevision(current, expectedRevision);
    const approved = approveEditingPlan(current);
    await this.save(approved);
    return approved;
  }

  async reject(planId: string, expectedRevision: number): Promise<EditingPlan> {
    const current = await this.get(planId);
    this.assertRevision(current, expectedRevision);
    if (current.status !== "draft") {
      throw new Error(`Only a draft plan can be rejected (current status: ${current.status}).`);
    }
    const rejected = EditingPlanSchema.parse({ ...current, status: "rejected" });
    await this.save(rejected);
    return rejected;
  }

  async markExecuted(planId: string, expectedRevision: number, requestId: string): Promise<EditingPlan> {
    const current = await this.get(planId);
    this.assertRevision(current, expectedRevision);
    if (current.executionRequestId !== requestId) {
      throw new Error("The supplied request id does not match this plan's queued execution.");
    }
    const executed = markEditingPlanExecuted(current);
    await this.save(executed);
    return executed;
  }

  async queueExecution(planId: string, expectedRevision: number, requestId: string): Promise<EditingPlan> {
    const current = await this.get(planId);
    this.assertRevision(current, expectedRevision);
    const executing = markEditingPlanExecuting(current, requestId);
    await this.save(executing);
    return executing;
  }

  async cancelExecution(planId: string, expectedRevision: number, requestId: string): Promise<EditingPlan> {
    const current = await this.get(planId);
    this.assertRevision(current, expectedRevision);
    if (current.status !== "executing" || current.executionRequestId !== requestId) {
      throw new Error("The plan does not have this queued execution to cancel.");
    }
    const approved = EditingPlanSchema.parse({
      ...current,
      status: "approved",
      executionRequestId: undefined,
      updatedAt: new Date().toISOString()
    });
    await this.save(approved);
    return approved;
  }

  private assertRevision(plan: EditingPlan, expectedRevision: number): void {
    if (plan.revision !== expectedRevision) {
      throw new Error(
        `Editing plan revision conflict: expected ${expectedRevision}, current revision is ${plan.revision}.`
      );
    }
  }

  private async save(plan: EditingPlan): Promise<void> {
    await ensureDir(this.plansDirectory);
    const value = `${JSON.stringify(plan, null, 2)}\n`;
    const current = this.planPath(plan.planId);
    await writeTextFileAtomic(current, value);
    const revisionPath = path.join(this.plansDirectory, `${plan.planId}.rev-${String(plan.revision).padStart(4, "0")}.json`);
    await writeTextFileAtomic(revisionPath, value);
  }

  private planPath(planId: string): string {
    if (!PLAN_ID_PATTERN.test(planId)) {
      throw new Error("Invalid editing plan id.");
    }
    return path.join(this.plansDirectory, `${planId}.json`);
  }
}
