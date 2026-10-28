from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.sensitivity import Sensitivity
from ..models.update_memory_request_layer import UpdateMemoryRequestLayer
from ..types import UNSET, Unset
from typing import cast
from uuid import UUID


T = TypeVar("T", bound="UpdateMemoryRequest")


@_attrs_define
class UpdateMemoryRequest:
    """
    Attributes:
        uri (str):
        expected_version (int | Unset):
        expected_id (UUID | Unset):
        content (str | Unset):
        layer (UpdateMemoryRequestLayer | Unset):
        sensitivity (Sensitivity | Unset):
        priority (int | Unset):
        disclosure (None | str | Unset):
        glossary_add (list[str] | Unset):
        glossary_remove (list[str] | Unset):
        allow_plaintext (bool | Unset):
    """

    uri: str
    expected_version: int | Unset = UNSET
    expected_id: UUID | Unset = UNSET
    content: str | Unset = UNSET
    layer: UpdateMemoryRequestLayer | Unset = UNSET
    sensitivity: Sensitivity | Unset = UNSET
    priority: int | Unset = UNSET
    disclosure: None | str | Unset = UNSET
    glossary_add: list[str] | Unset = UNSET
    glossary_remove: list[str] | Unset = UNSET
    allow_plaintext: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        uri = self.uri

        expected_version = self.expected_version

        expected_id: str | Unset = UNSET
        if not isinstance(self.expected_id, Unset):
            expected_id = str(self.expected_id)

        content = self.content

        layer: str | Unset = UNSET
        if not isinstance(self.layer, Unset):
            layer = self.layer.value

        sensitivity: str | Unset = UNSET
        if not isinstance(self.sensitivity, Unset):
            sensitivity = self.sensitivity.value

        priority = self.priority

        disclosure: None | str | Unset
        if isinstance(self.disclosure, Unset):
            disclosure = UNSET
        else:
            disclosure = self.disclosure

        glossary_add: list[str] | Unset = UNSET
        if not isinstance(self.glossary_add, Unset):
            glossary_add = self.glossary_add

        glossary_remove: list[str] | Unset = UNSET
        if not isinstance(self.glossary_remove, Unset):
            glossary_remove = self.glossary_remove

        allow_plaintext = self.allow_plaintext

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "uri": uri,
            }
        )
        if expected_version is not UNSET:
            field_dict["expectedVersion"] = expected_version
        if expected_id is not UNSET:
            field_dict["expectedId"] = expected_id
        if content is not UNSET:
            field_dict["content"] = content
        if layer is not UNSET:
            field_dict["layer"] = layer
        if sensitivity is not UNSET:
            field_dict["sensitivity"] = sensitivity
        if priority is not UNSET:
            field_dict["priority"] = priority
        if disclosure is not UNSET:
            field_dict["disclosure"] = disclosure
        if glossary_add is not UNSET:
            field_dict["glossaryAdd"] = glossary_add
        if glossary_remove is not UNSET:
            field_dict["glossaryRemove"] = glossary_remove
        if allow_plaintext is not UNSET:
            field_dict["allowPlaintext"] = allow_plaintext

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        uri = d.pop("uri")

        expected_version = d.pop("expectedVersion", UNSET)

        _expected_id = d.pop("expectedId", UNSET)
        expected_id: UUID | Unset
        if isinstance(_expected_id, Unset):
            expected_id = UNSET
        else:
            expected_id = UUID(_expected_id)

        content = d.pop("content", UNSET)

        _layer = d.pop("layer", UNSET)
        layer: UpdateMemoryRequestLayer | Unset
        if isinstance(_layer, Unset):
            layer = UNSET
        else:
            layer = UpdateMemoryRequestLayer(_layer)

        _sensitivity = d.pop("sensitivity", UNSET)
        sensitivity: Sensitivity | Unset
        if isinstance(_sensitivity, Unset):
            sensitivity = UNSET
        else:
            sensitivity = Sensitivity(_sensitivity)

        priority = d.pop("priority", UNSET)

        def _parse_disclosure(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        disclosure = _parse_disclosure(d.pop("disclosure", UNSET))

        glossary_add = cast(list[str], d.pop("glossaryAdd", UNSET))

        glossary_remove = cast(list[str], d.pop("glossaryRemove", UNSET))

        allow_plaintext = d.pop("allowPlaintext", UNSET)

        update_memory_request = cls(
            uri=uri,
            expected_version=expected_version,
            expected_id=expected_id,
            content=content,
            layer=layer,
            sensitivity=sensitivity,
            priority=priority,
            disclosure=disclosure,
            glossary_add=glossary_add,
            glossary_remove=glossary_remove,
            allow_plaintext=allow_plaintext,
        )

        update_memory_request.additional_properties = d
        return update_memory_request

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
