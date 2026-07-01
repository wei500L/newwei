import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProduces, ApiTags } from "@nestjs/swagger";
import { AnalysisSubjectType } from ".prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { AnalysisWorkspaceService } from "./analysis-workspace.service";
import {
  CreateAnalysisBoardColumnDto,
  CreateAnalysisBoardDto,
  CreateAnalysisCommentDto,
  CreateAnalysisTaskDto,
  DeleteAnalysisBoardColumnDto,
  CreateSavedAnalysisViewDto,
  ExportAnalysisQueryDto,
  ListSavedAnalysisViewsDto,
  MoveAnalysisTaskDto,
  ReorderAnalysisBoardColumnsDto,
  UpdateAnalysisBoardColumnDto,
  UpdateAnalysisBoardDto,
  UpdateAnalysisCommentDto,
  UpdateAnalysisTaskDto,
  UpdateSavedAnalysisViewDto,
  UpsertAnalysisThreadDto,
} from "./dto/saved-analysis-view.dto";

@ApiTags("analysis-workspace")
@ApiBearerAuth()
@Controller("analysis")
export class AnalysisWorkspaceController {
  constructor(private readonly workspace: AnalysisWorkspaceService) {}

  @Get("views")
  @Header("Cache-Control", "no-store")
  @Permissions("analysis.read")
  async listViews(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListSavedAnalysisViewsDto,
  ) {
    return this.workspace.listViews(user.orgId, user, query);
  }

  @Get("views/:id")
  @Header("Cache-Control", "no-store")
  @Permissions("analysis.read")
  async getView(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.workspace.getView(user.orgId, user, id);
  }

  @Post("views")
  @Permissions("analysis.write")
  async createView(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateSavedAnalysisViewDto,
  ) {
    return this.workspace.createView(user.orgId, user, body);
  }

  @Patch("views/:id")
  @Permissions("analysis.write")
  async updateView(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: UpdateSavedAnalysisViewDto,
  ) {
    return this.workspace.updateView(user.orgId, user, id, body);
  }

  @Delete("views/:id")
  @Permissions("analysis.write")
  async deleteView(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.workspace.deleteView(user.orgId, user, id);
  }

  @Get("boards")
  @Header("Cache-Control", "no-store")
  @Permissions("analysis.read")
  async listBoards(@CurrentUser() user: AuthenticatedUser) {
    return this.workspace.listBoards(user.orgId, user);
  }

  @Post("boards")
  @Permissions("analysis.write")
  async createBoard(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAnalysisBoardDto,
  ) {
    return this.workspace.createBoard(user.orgId, user, body);
  }

  @Get("boards/:boardId")
  @Header("Cache-Control", "no-store")
  @Permissions("analysis.read")
  async getBoard(
    @CurrentUser() user: AuthenticatedUser,
    @Param("boardId") boardId: string,
  ) {
    return this.workspace.getBoard(user.orgId, user, boardId);
  }

  @Patch("boards/:boardId")
  @Permissions("analysis.write")
  async updateBoard(
    @CurrentUser() user: AuthenticatedUser,
    @Param("boardId") boardId: string,
    @Body() body: UpdateAnalysisBoardDto,
  ) {
    return this.workspace.updateBoard(user.orgId, user, boardId, body);
  }

  @Delete("boards/:boardId")
  @Permissions("analysis.write")
  async archiveBoard(
    @CurrentUser() user: AuthenticatedUser,
    @Param("boardId") boardId: string,
  ) {
    return this.workspace.archiveBoard(user.orgId, user, boardId);
  }

  @Post("boards/:boardId/columns")
  @Permissions("analysis.write")
  async createColumn(
    @CurrentUser() user: AuthenticatedUser,
    @Param("boardId") boardId: string,
    @Body() body: CreateAnalysisBoardColumnDto,
  ) {
    return this.workspace.createColumn(user.orgId, user, boardId, body);
  }

  @Post("boards/:boardId/columns/reorder")
  @Permissions("analysis.write")
  async reorderColumns(
    @CurrentUser() user: AuthenticatedUser,
    @Param("boardId") boardId: string,
    @Body() body: ReorderAnalysisBoardColumnsDto,
  ) {
    return this.workspace.reorderColumns(
      user.orgId,
      user,
      boardId,
      body.columnIds,
    );
  }

  @Patch("columns/:columnId")
  @Permissions("analysis.write")
  async updateColumn(
    @CurrentUser() user: AuthenticatedUser,
    @Param("columnId") columnId: string,
    @Body() body: UpdateAnalysisBoardColumnDto,
  ) {
    return this.workspace.updateColumn(user.orgId, user, columnId, body);
  }

  @Delete("columns/:columnId")
  @Permissions("analysis.write")
  async deleteColumn(
    @CurrentUser() user: AuthenticatedUser,
    @Param("columnId") columnId: string,
    @Body() body: DeleteAnalysisBoardColumnDto,
  ) {
    return this.workspace.deleteColumn(
      user.orgId,
      user,
      columnId,
      body.moveCardsToColumnId,
    );
  }

  @Post("boards/:boardId/tasks")
  @Permissions("analysis.write")
  async createTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("boardId") boardId: string,
    @Body() body: CreateAnalysisTaskDto,
  ) {
    return this.workspace.createTask(user.orgId, user, boardId, body);
  }

  @Patch("tasks/:taskId")
  @Permissions("analysis.write")
  async updateTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("taskId") taskId: string,
    @Body() body: UpdateAnalysisTaskDto,
  ) {
    return this.workspace.updateTask(user.orgId, user, taskId, body);
  }

  @Delete("tasks/:taskId")
  @Permissions("analysis.write")
  async deleteTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("taskId") taskId: string,
  ) {
    return this.workspace.deleteTask(user.orgId, user, taskId);
  }

  @Post("tasks/:taskId/move")
  @Permissions("analysis.write")
  async moveTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("taskId") taskId: string,
    @Body() body: MoveAnalysisTaskDto,
  ) {
    return this.workspace.moveTask(user.orgId, user, taskId, body);
  }

  @Get("threads/:subjectType/:subjectId")
  @Header("Cache-Control", "no-store")
  @Permissions("analysis.read")
  async getThread(
    @CurrentUser() user: AuthenticatedUser,
    @Param("subjectType", new ParseEnumPipe(AnalysisSubjectType))
    subjectType: AnalysisSubjectType,
    @Param("subjectId") subjectId: string,
  ) {
    return this.workspace.getThread(
      user.orgId,
      user.id,
      subjectType,
      subjectId,
    );
  }

  @Put("threads/:subjectType/:subjectId")
  @Permissions("analysis.write")
  async upsertThread(
    @CurrentUser() user: AuthenticatedUser,
    @Param("subjectType", new ParseEnumPipe(AnalysisSubjectType))
    subjectType: AnalysisSubjectType,
    @Param("subjectId") subjectId: string,
    @Body() body: UpsertAnalysisThreadDto,
  ) {
    return this.workspace.upsertThread(
      user.orgId,
      user,
      subjectType,
      subjectId,
      body.noteMarkdown,
    );
  }

  @Post("threads/:subjectType/:subjectId/comments")
  @Permissions("analysis.write")
  async createComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("subjectType", new ParseEnumPipe(AnalysisSubjectType))
    subjectType: AnalysisSubjectType,
    @Param("subjectId") subjectId: string,
    @Body() body: CreateAnalysisCommentDto,
  ) {
    return this.workspace.createComment(
      user.orgId,
      user,
      subjectType,
      subjectId,
      body.bodyMarkdown,
    );
  }

  @Patch("comments/:commentId")
  @Permissions("analysis.write")
  async updateComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("commentId") commentId: string,
    @Body() body: UpdateAnalysisCommentDto,
  ) {
    return this.workspace.updateComment(
      user.orgId,
      user,
      commentId,
      body.bodyMarkdown,
    );
  }

  @Delete("comments/:commentId")
  @Permissions("analysis.write")
  async deleteComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("commentId") commentId: string,
  ) {
    return this.workspace.deleteComment(user.orgId, user, commentId);
  }

  @Post("exports/search")
  @ApiProduces("text/csv")
  @Permissions("analysis.write")
  async exportSearch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ExportAnalysisQueryDto,
  ) {
    const result = await this.workspace.exportSearchCsvStream(
      user,
      body.queryString,
    );
    return new StreamableFile(result.stream, {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="analysis-search-export.csv"',
    });
  }

  @Post("exports/items")
  @ApiProduces("text/csv")
  @Permissions("analysis.write")
  async exportItems(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ExportAnalysisQueryDto,
  ) {
    const result = await this.workspace.exportItemsCsvStream(
      user,
      body.queryString,
    );
    return new StreamableFile(result.stream, {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="analysis-items-export.csv"',
    });
  }

  @Post("exports/events")
  @ApiProduces("text/csv")
  @Permissions("analysis.write")
  async exportEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ExportAnalysisQueryDto,
  ) {
    const result = await this.workspace.exportEventsCsvStream(
      user,
      body.queryString,
    );
    return new StreamableFile(result.stream, {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="analysis-events-export.csv"',
    });
  }
}
