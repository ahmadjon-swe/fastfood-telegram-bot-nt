import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

export enum ProductCategory {
  FOOD = 'food',
  DRINKS = 'drinks',
  DESSERTS = 'desserts',
}

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  price: number;

  @Prop()
  image?: string;

  @Prop()
  description?: string;

  @Prop({ type: String, enum: ProductCategory, required: true })
  category: ProductCategory;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ required: true })
  createdBy: number; // chatId of seller/manager who created it
}

export const ProductSchema = SchemaFactory.createForClass(Product);
