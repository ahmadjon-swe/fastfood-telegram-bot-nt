import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TopupDocument = Topup & Document;

export enum TopupStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
}

@Schema({ timestamps: true })
export class Topup {
  @Prop({ required: true })
  chatId: number;

  @Prop({ required: true })
  amount: number;

  @Prop({ type: String, enum: TopupStatus, default: TopupStatus.PENDING })
  status: TopupStatus;

  @Prop()
  confirmedBy?: number; // manager chatId
}

export const TopupSchema = SchemaFactory.createForClass(Topup);