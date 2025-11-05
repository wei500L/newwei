import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { ItemsService } from "./items.service";
import { CreateItemDto } from "./dto/create-item.dto";
import { ListItemsDto } from "./dto/list-items.dto";

@ApiTags("items")
@ApiBearerAuth()
@Controller("items")
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Permissions("items.read")
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListItemsDto) {
    const page = query.page ? Number(query.page) : 1;
    const pageSize = query.pageSize ? Number(query.pageSize) : 10;
    return this.itemsService.list(user.orgId, page, pageSize, query.search);
  }

  @Permissions("items.write")
  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateItemDto) {
    return this.itemsService.create(user.orgId, user.id, body);
  }

  @Permissions("items.read")
  @Get(":id")
  async detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.itemsService.get(user.orgId, id);
  }
}
