from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.create_memory_request_layer import CreateMemoryRequestLayer
from ..models.create_memory_request_sensitivity import CreateMemoryRequestSensitivity
from ..types import UNSET, Unset
from typing import cast
import datetime


T = TypeVar("T", bound="CreateMemoryRequest")


@_attrs_define
class CreateMemoryRequest:
    """
    Attributes:
        uri (str):
        content (str):
        layer (CreateMemoryRequestLayer | Unset):
        sensitivity (CreateMemoryRequestSensitivity | Unset):
        priority (int | Unset):  Default: 2.
        disclosure (str | Unset):
        glossary (list[str] | Unset):
        valid_to (datetime.datetime | Unset):
    """

    uri: str
    content: str
    layer: CreateMemoryRequestLayer | Unset = UNSET
    sensitivity: CreateMemoryRequestSensitivity | Unset = UNSET
    priority: int | Unset = 2
    disclosure: str | Unset = UNSET
    glossary: list[str] | Unset = UNSET
    valid_to: datetime.datetime | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        uri = self.uri

        content = self.content

        layer: str | Unset = UNSET
        if not isinstance(self.layer, Unset):
            layer = self.layer.value

        sensitivity: str | Unset = UNSET
        if not isinstance(self.sensitivity, Unset):
            sensitivity = self.sensitivity.value

        priority = self.priority

        disclosure = self.disclosure

        glossary: list[str] | Unset = UNSET
        if not isinstance(self.glossary, Unset):
            glossary = self.glossary

        valid_to: str | Unset = UNSET
        if not isinstance(self.valid_to, Unset):
            valid_to = self.valid_to.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "uri": uri,
                "content": content,
            }
        )
        if layer is not UNSET:
            field_dict["layer"] = layer
        if sensitivity is not UNSET:
            field_dict["sensitivity"] = sensitivity
        if priority is not UNSET:
            field_dict["priority"] = priority
        if disclosure is not UNSET:
            field_dict["disclosure"] = disclosure
        if glossary is not UNSET:
            field_dict["glossary"] = glossary
        if valid_to is not UNSET:
            field_dict["validTo"] = valid_to

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        uri = d.pop("uri")

        content = d.pop("content")

        _layer = d.pop("layer", UNSET)
        layer: CreateMemoryRequestLayer | Unset
        if isinstance(_layer, Unset):
            layer = UNSET
        else:
            layer = CreateMemoryRequestLayer(_layer)

        _sensitivity = d.pop("sensitivity", UNSET)
        sensitivity: CreateMemoryRequestSensitivity | Unset
        if isinstance(_sensitivity, Unset):
            sensitivity = UNSET
        else:
            sensitivity = CreateMemoryRequestSensitivity(_sensitivity)

        priority = d.pop("priority", UNSET)

        disclosure = d.pop("disclosure", UNSET)

        glossary = cast(list[str], d.pop("glossary", UNSET))

        _valid_to = d.pop("validTo", UNSET)
        valid_to: datetime.datetime | Unset
        if isinstance(_valid_to, Unset):
            valid_to = UNSET
        else:
            valid_to = datetime.datetime.fromisoformat(_valid_to)

        create_memory_request = cls(
            uri=uri,
            content=content,
            layer=layer,
            sensitivity=sensitivity,
            priority=priority,
            disclosure=disclosure,
            glossary=glossary,
            valid_to=valid_to,
        )

        create_memory_request.additional_properties = d
        return create_memory_request

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
