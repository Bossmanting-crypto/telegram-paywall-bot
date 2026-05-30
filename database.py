"""
database.py – SQLAlchemy (sync, SQLite-friendly) models & helpers.
Uses SQLite locally and PostgreSQL in production via DATABASE_URL.
"""

from datetime import datetime, timedelta
from sqlalchemy import (
    create_engine, Column, Integer, BigInteger, String,
    DateTime, Boolean, Float, Enum, Text
)
from sqlalchemy.orm import declarative_base, sessionmaker
import enum
from config import DATABASE_URL

engine  = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {})
Session = sessionmaker(bind=engine)
Base    = declarative_base()


# ── Enums ─────────────────────────────────────────────────────────────────────

class AccessType(str, enum.Enum):
    ONE_TIME   = "one_time"
    MONTHLY    = "monthly"

class PaymentProvider(str, enum.Enum):
    NOWPAYMENTS = "nowpayments"
    BTCPAY      = "btcpay"
    PAYSTACK    = "paystack"

class PaymentStatus(str, enum.Enum):
    PENDING   = "pending"
    CONFIRMED = "confirmed"
    FAILED    = "failed"
    EXPIRED   = "expired"


# ── Models ────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id              = Column(Integer, primary_key=True)
    telegram_id     = Column(BigInteger, unique=True, nullable=False, index=True)
    username        = Column(String(64))
    first_name      = Column(String(128))
    chat_id         = Column(BigInteger)        # group they want access to
    has_access      = Column(Boolean, default=False)
    access_type     = Column(Enum(AccessType), nullable=True)
    access_expires  = Column(DateTime, nullable=True)   # None = lifetime
    joined_at       = Column(DateTime, default=datetime.utcnow)
    last_seen       = Column(DateTime, default=datetime.utcnow)

    def is_access_valid(self) -> bool:
        if not self.has_access:
            return False
        if self.access_type == AccessType.ONE_TIME:
            return True
        if self.access_expires and datetime.utcnow() > self.access_expires:
            return False
        return True


class Payment(Base):
    __tablename__ = "payments"

    id              = Column(Integer, primary_key=True)
    telegram_id     = Column(BigInteger, nullable=False, index=True)
    provider        = Column(Enum(PaymentProvider), nullable=False)
    provider_ref    = Column(String(256), index=True)   # invoice/order ID from provider
    access_type     = Column(Enum(AccessType), nullable=False)
    amount_usd      = Column(Float)
    amount_local    = Column(Float)
    currency        = Column(String(8))
    status          = Column(Enum(PaymentStatus), default=PaymentStatus.PENDING)
    payment_url     = Column(Text)
    created_at      = Column(DateTime, default=datetime.utcnow)
    confirmed_at    = Column(DateTime, nullable=True)
    metadata_json   = Column(Text, nullable=True)   # raw provider data


# ── DB Helpers ────────────────────────────────────────────────────────────────

def init_db():
    Base.metadata.create_all(engine)

def get_or_create_user(telegram_id: int, username: str = None, first_name: str = None) -> User:
    with Session() as s:
        user = s.query(User).filter_by(telegram_id=telegram_id).first()
        if not user:
            user = User(telegram_id=telegram_id, username=username, first_name=first_name)
            s.add(user)
            s.commit()
            s.refresh(user)
        return user

def get_user(telegram_id: int) -> User | None:
    with Session() as s:
        return s.query(User).filter_by(telegram_id=telegram_id).first()

def set_user_access(telegram_id: int, access_type: AccessType):
    with Session() as s:
        user = s.query(User).filter_by(telegram_id=telegram_id).first()
        if user:
            user.has_access   = True
            user.access_type  = access_type
            if access_type == AccessType.MONTHLY:
                user.access_expires = datetime.utcnow() + timedelta(days=30)
            s.commit()

def revoke_user_access(telegram_id: int):
    with Session() as s:
        user = s.query(User).filter_by(telegram_id=telegram_id).first()
        if user:
            user.has_access   = False
            user.access_expires = None
            s.commit()

def create_payment(telegram_id: int, provider: PaymentProvider,
                   provider_ref: str, access_type: AccessType,
                   amount_usd: float, amount_local: float,
                   currency: str, payment_url: str) -> Payment:
    with Session() as s:
        p = Payment(
            telegram_id=telegram_id, provider=provider,
            provider_ref=provider_ref, access_type=access_type,
            amount_usd=amount_usd, amount_local=amount_local,
            currency=currency, payment_url=payment_url
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        return p

def confirm_payment(provider_ref: str) -> Payment | None:
    with Session() as s:
        p = s.query(Payment).filter_by(provider_ref=provider_ref).first()
        if p and p.status != PaymentStatus.CONFIRMED:
            p.status        = PaymentStatus.CONFIRMED
            p.confirmed_at  = datetime.utcnow()
            s.commit()
            s.refresh(p)
        return p

def get_payment_by_ref(provider_ref: str) -> Payment | None:
    with Session() as s:
        return s.query(Payment).filter_by(provider_ref=provider_ref).first()

def get_expired_subscriptions():
    with Session() as s:
        return s.query(User).filter(
            User.has_access == True,
            User.access_type == AccessType.MONTHLY,
            User.access_expires <= datetime.utcnow()
        ).all()
